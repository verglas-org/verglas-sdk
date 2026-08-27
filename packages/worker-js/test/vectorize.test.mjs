import test from 'node:test';
import assert from 'node:assert/strict';

import { createVectorizeBinding, createWorker } from '../src/cloudflare-workers.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function response(status, value) {
  return {
    status,
    headers: [['content-type', 'application/json']],
    body: encoder.encode(JSON.stringify(value)),
  };
}

test('Vectorize methods use the fixed index identity and Cloudflare payload names', async () => {
  const calls = [];
  const index = createVectorizeBinding('VECTORIZE', 'documents', {
    doFetch(binding, object, request) {
      calls.push({ binding, object, request });
      if (request.uri.endsWith('/query') || request.uri.endsWith('/query-by-id')) {
        return response(200, { count: 1, matches: [{ id: 'a', score: 1 }] });
      }
      if (request.uri.endsWith('/describe')) {
        return response(200, { dimensions: 3, metric: 'cosine' });
      }
      if (request.uri.endsWith('/get-by-ids')) {
        return response(200, [{ id: 'a', values: [1, 0, 0] }]);
      }
      return response(200, { mutationId: 'mutation-1' });
    },
  });

  assert.deepEqual(await index.insert([{ id: 'a', values: [1, 0, 0] }]), { mutationId: 'mutation-1' });
  assert.deepEqual(await index.upsert([{ id: 'a', values: [0, 1, 0], metadata: { kind: 'doc' } }]), { mutationId: 'mutation-1' });
  assert.deepEqual(await index.query([1, 0, 0], { topK: 1, returnValues: true }), {
    count: 1,
    matches: [{ id: 'a', score: 1 }],
  });
  assert.deepEqual(await index.queryById('a', { topK: 1 }), {
    count: 1,
    matches: [{ id: 'a', score: 1 }],
  });
  assert.deepEqual(await index.getByIds(['a']), [{ id: 'a', values: [1, 0, 0] }]);
  assert.deepEqual(await index.deleteByIds(['a']), { mutationId: 'mutation-1' });
  assert.deepEqual(await index.describe(), { dimensions: 3, metric: 'cosine' });

  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ binding }) => binding === 'VECTORIZE'));
  assert.ok(calls.every(({ object }) => object === 'documents'));
  assert.deepEqual(calls.map(({ request }) => request.uri), [
    'https://verglas.internal/vectorize/insert',
    'https://verglas.internal/vectorize/upsert',
    'https://verglas.internal/vectorize/query',
    'https://verglas.internal/vectorize/query-by-id',
    'https://verglas.internal/vectorize/get-by-ids',
    'https://verglas.internal/vectorize/delete-by-ids',
    'https://verglas.internal/vectorize/describe',
  ]);
  assert.deepEqual(JSON.parse(decoder.decode(calls[2].request.body)), {
    vector: [1, 0, 0],
    topK: 1,
    returnValues: true,
  });
});

test('Worker environments expose Vectorize methods without namespace methods', async () => {
  const worker = createWorker({
    default: {
      async fetch(_request, env) {
        return Response.json(await env.VECTORIZE.describe());
      },
    },
  }, {
    vectorize: [{ binding: 'VECTORIZE', index_name: 'documents' }],
  }, {
    transport: {
      doFetch() {
        return response(200, { dimensions: 768, metric: 'cosine' });
      },
    },
  });
  assert.equal(typeof worker.env.VECTORIZE.query, 'function');
  assert.equal(worker.env.VECTORIZE.idFromName, undefined);
  const result = await worker.fetch({ method: 'GET', uri: 'https://worker.test/', headers: [], body: [] });
  assert.deepEqual(JSON.parse(decoder.decode(result.body)), { dimensions: 768, metric: 'cosine' });
});

test('Vectorize validates finite vectors and rejects non-2xx results', async () => {
  let calls = 0;
  const index = createVectorizeBinding('VECTORIZE', 'documents', {
    doFetch() {
      calls += 1;
      return response(400, { error: 'dimension mismatch' });
    },
  });
  await assert.rejects(index.insert([{ id: 'bad', values: [Number.NaN] }]), /finite/i);
  assert.equal(calls, 0);
  await assert.rejects(index.query([1, 2, 3]), /dimension mismatch/i);
  assert.equal(calls, 1);
});
