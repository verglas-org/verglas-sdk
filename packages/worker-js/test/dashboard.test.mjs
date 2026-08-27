import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BarChart, Card, Dashboard, DataTable, Metric, createDashboard, h,
} from '../src/dashboard.js';

test('stateless Dashboard renders query-backed semantic JSX with escaped values', async () => {
  const calls = [];
  const worker = createDashboard({
    title: 'Sales <overview>',
    render() {
      return h(Dashboard, {},
        h(Card, { title: 'Current' },
          h(Metric, {
            label: 'Revenue', field: 'revenue',
            query: { binding: 'SALES', endpoint: 'total', params: { region: 'west' } },
          })),
        h(DataTable, {
          columns: [{ key: 'customer', label: 'Customer' }],
          query: { binding: 'SALES', endpoint: 'customers', params: {} },
        }),
        h(BarChart, {
          x: 'day', y: 'revenue',
          query: { binding: 'SALES', endpoint: 'daily', params: {} },
        }));
    },
  });
  const env = {
    SALES: {
      async query(endpoint, params) {
        calls.push({ endpoint, params });
        if (endpoint === 'total') return { rows: [{ revenue: '<script>alert(1)</script>' }] };
        if (endpoint === 'customers') return { rows: [{ customer: '<img src=x onerror=alert(1)>' }] };
        return { rows: [{ day: 'Mon', revenue: 2 }, { day: 'Tue', revenue: 4 }] };
      },
    },
  };
  const response = await worker.fetch(new Request('https://dashboard.test/'), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.match(html, /Sales &lt;overview&gt;/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>|<img/u);
  assert.match(html, /<svg/u);
  assert.deepEqual(calls, [
    { endpoint: 'total', params: { region: 'west' } },
    { endpoint: 'customers', params: {} },
    { endpoint: 'daily', params: {} },
  ]);
});

test('Dashboard rejects oversized query results instead of truncating them', async () => {
  const worker = createDashboard({
    title: 'Large',
    render: () => h(DataTable, {
      columns: [{ key: 'id', label: 'ID' }],
      query: { binding: 'ROWS', endpoint: 'all', params: {} },
    }),
  });
  const response = await worker.fetch(new Request('https://dashboard.test/'), {
    ROWS: { query: async () => ({ rows: Array.from({ length: 121 }, (_, id) => ({ id })) }) },
  });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /row ceiling/i);
});
