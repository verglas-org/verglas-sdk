import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueryBinding, createWorker } from '../src/cloudflare-workers.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function response(status, value) {
  return {
    status,
    headers: [['content-type', 'application/json']],
    body: encoder.encode(JSON.stringify(value)),
  };
}

test('Query methods use one fixed query identity and typed endpoint payloads', async () => {
  const calls = [];
  const query = createQueryBinding('ANALYTICS', 'sales', {
    doFetch(binding, object, request) {
      calls.push({ binding, object, request });
      if (request.uri.endsWith('/describe')) return response(200, { name: 'sales', views: [], endpoints: [] });
      return response(200, { endpoint: 'revenue', rows: [{ revenue: 42 }], watermark: { orders: 7 } });
    },
  });

  assert.equal((await query.query('revenue', { region: 'west', days: 30 })).rows[0].revenue, 42);
  assert.equal((await query.describe()).name, 'sales');
  assert.deepEqual(calls.map(({ binding, object }) => [binding, object]), [
    ['ANALYTICS', 'sales'], ['ANALYTICS', 'sales'],
  ]);
  assert.deepEqual(calls.map(({ request }) => request.uri), [
    'https://verglas.internal/query/run',
    'https://verglas.internal/query/describe',
  ]);
  assert.deepEqual(JSON.parse(decoder.decode(calls[0].request.body)), {
    endpoint: 'revenue', params: { region: 'west', days: 30 },
  });
});

test('Worker environments expose Query without Durable Object namespace methods', async () => {
  const worker = createWorker({
    default: {
      async fetch(_request, env) {
        return Response.json(await env.ANALYTICS.describe());
      },
    },
  }, {
    queries: [{ binding: 'ANALYTICS', query_name: 'sales' }],
  }, {
    transport: { doFetch: () => response(200, { name: 'sales' }) },
  });
  assert.equal(typeof worker.env.ANALYTICS.query, 'function');
  assert.equal(worker.env.ANALYTICS.idFromName, undefined);
  const result = await worker.fetch({ method: 'GET', uri: 'https://worker.test/', headers: [], body: [] });
  assert.equal(JSON.parse(decoder.decode(result.body)).name, 'sales');
});

test('Query rejects invalid endpoints and parameters before crossing the binding', async () => {
  let calls = 0;
  const query = createQueryBinding('ANALYTICS', 'sales', {
    doFetch() {
      calls += 1;
      return response(200, { rows: [] });
    },
  });
  await assert.rejects(query.query('', {}), /endpoint/i);
  await assert.rejects(query.query('sales', { bad: undefined }), /JSON/i);
  assert.equal(calls, 0);
});
