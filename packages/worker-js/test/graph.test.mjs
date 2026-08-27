import test from 'node:test';
import assert from 'node:assert/strict';

import { createGraphBinding, createWorker } from '../src/cloudflare-workers.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function response(status, value) {
  return {
    status,
    headers: [['content-type', 'application/json']],
    body: encoder.encode(JSON.stringify(value)),
  };
}

test('Graph methods use one fixed graph identity and canonical payloads', async () => {
  const calls = [];
  const graph = createGraphBinding('GRAPH', 'knowledge', {
    doFetch(binding, object, request) {
      calls.push({ binding, object, request });
      if (request.uri.endsWith('/get-nodes')) return response(200, [{ id: 'a', kind: 'person' }]);
      if (request.uri.endsWith('/get-edges')) return response(200, [{ id: 'e', from: 'a', to: 'b', kind: 'knows' }]);
      if (request.uri.endsWith('/neighbors')) return response(200, { nodes: [], edges: [], depthReached: 0 });
      if (request.uri.endsWith('/shortest-path')) return response(200, { found: false, nodes: [], edges: [], hops: 0 });
      if (request.uri.endsWith('/describe')) return response(200, { name: 'knowledge', nodes: 1, edges: 1 });
      return response(200, { mutationId: 'mutation-1' });
    },
  });

  await graph.upsertNodes([{ id: 'a', kind: 'person', properties: { active: true } }]);
  await graph.upsertEdges([{ id: 'e', from: 'a', to: 'b', kind: 'knows', weight: 1 }]);
  assert.deepEqual(await graph.getNodes(['a']), [{ id: 'a', kind: 'person' }]);
  assert.equal((await graph.getEdges(['e']))[0].from, 'a');
  await graph.deleteNodes(['a']);
  await graph.deleteEdges(['e']);
  await graph.neighbors('a', { direction: 'out', depth: 2, edgeKinds: ['knows'] });
  await graph.shortestPath('a', 'b', { direction: 'both', maxDepth: 4 });
  assert.equal((await graph.describe()).name, 'knowledge');

  assert.equal(calls.length, 9);
  assert.ok(calls.every(({ binding }) => binding === 'GRAPH'));
  assert.ok(calls.every(({ object }) => object === 'knowledge'));
  assert.deepEqual(calls.map(({ request }) => request.uri), [
    'https://verglas.internal/graph/upsert-nodes',
    'https://verglas.internal/graph/upsert-edges',
    'https://verglas.internal/graph/get-nodes',
    'https://verglas.internal/graph/get-edges',
    'https://verglas.internal/graph/delete-nodes',
    'https://verglas.internal/graph/delete-edges',
    'https://verglas.internal/graph/neighbors',
    'https://verglas.internal/graph/shortest-path',
    'https://verglas.internal/graph/describe',
  ]);
  assert.deepEqual(JSON.parse(decoder.decode(calls[6].request.body)), {
    id: 'a', direction: 'out', depth: 2, edgeKinds: ['knows'],
  });
});

test('Worker environments expose Graph methods without namespace methods', async () => {
  const worker = createWorker({
    default: {
      async fetch(_request, env) {
        return Response.json(await env.GRAPH.describe());
      },
    },
  }, {
    graphs: [{ binding: 'GRAPH', graph_name: 'knowledge' }],
  }, {
    transport: { doFetch: () => response(200, { name: 'knowledge', nodes: 0, edges: 0 }) },
  });
  assert.equal(typeof worker.env.GRAPH.neighbors, 'function');
  assert.equal(worker.env.GRAPH.idFromName, undefined);
  const result = await worker.fetch({ method: 'GET', uri: 'https://worker.test/', headers: [], body: [] });
  assert.equal(JSON.parse(decoder.decode(result.body)).name, 'knowledge');
});

test('Graph validates records before crossing the binding', async () => {
  let calls = 0;
  const graph = createGraphBinding('GRAPH', 'knowledge', {
    doFetch() {
      calls += 1;
      return response(200, { mutationId: 'mutation-1' });
    },
  });
  await assert.rejects(graph.upsertEdges([{ id: 'e', from: 'a', to: 'b', kind: 'k', weight: Number.NaN }]), /finite/i);
  await assert.rejects(graph.neighbors('a', { depth: 100 }), /depth/i);
  assert.equal(calls, 0);
});
