import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWranglerManifest } from '../src/manifest.js';

function base(extra = {}) { return { name: 'query-worker', main: 'worker.js', ...extra }; }

test('accepts the Cloudflare Wrangler manifest subset', () => {
  const manifest = parseWranglerManifest({
    name: 'counter',
    main: 'worker.js',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: {
      bindings: [{ name: 'COUNTER', class_name: 'Counter' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
    vars: { GREETING: 'hello' },
  });

  assert.deepEqual(manifest, {
    name: 'counter',
    main: 'worker.js',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [{ name: 'COUNTER', class_name: 'Counter' }],
    migrations: [{ tag: 'v1', new_classes: [], new_sqlite_classes: ['Counter'] }],
    vars: { GREETING: 'hello' },
  });
});

test('accepts omitted optional Wrangler fields with explicit empty values', () => {
  assert.deepEqual(parseWranglerManifest({
    name: 'counter',
    main: 'worker.js',
    durable_objects: { bindings: [] },
  }), {
    name: 'counter',
    main: 'worker.js',
    compatibility_flags: [],
    bindings: [],
    migrations: [],
    vars: {},
  });
});

test('accepts Cloudflare cron triggers and preserves them in the build manifest', () => {
  assert.deepEqual(parseWranglerManifest({
    name: 'scheduled-worker',
    main: 'worker.js',
    triggers: { crons: ['*/5 * * * *', '0 0 * * mon'] },
  }).triggers, {
    crons: ['*/5 * * * *', '0 0 * * mon'],
  });
});

test('accepts Verglas historical catch-up controls', () => {
  assert.deepEqual(parseWranglerManifest({
    name: 'market-ingest',
    main: 'worker.js',
    triggers: { crons: [{
      cron: '0 0 * * *',
      start_date: '2024-01-01T00:00:00Z',
      max_concurrent: 4,
    }] },
  }).triggers, {
    crons: [{
      cron: '0 0 * * *',
      start_date: '2024-01-01T00:00:00Z',
      max_concurrent: 4,
    }],
  });
});

test('rejects malformed cron trigger manifests', () => {
  assert.throws(() => parseWranglerManifest(base({ triggers: { crons: [''] } })), /triggers\.crons/u);
  assert.throws(() => parseWranglerManifest(base({ triggers: { crons: ['* * * * *'], extra: true } })), /unknown triggers key: extra/u);
  assert.throws(() => parseWranglerManifest(base({ triggers: { crons: [{ cron: '* * * * *', max_concurrent: 0 }] } })), /max_concurrent/u);
});

test('rejects an unknown top-level manifest key by name', () => {
  assert.throws(
    () => parseWranglerManifest({ name: 'counter', main: 'worker.js', unknown_field: true }),
    /unknown top-level key.*unknown_field/i,
  );
});

test('rejects a missing name', () => {
  assert.throws(() => parseWranglerManifest({ main: 'worker.js' }), /name.*required/i);
});

test('rejects a missing main', () => {
  assert.throws(() => parseWranglerManifest({ name: 'counter' }), /main.*required/i);
});

test('rejects malformed durable object bindings', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'counter',
      main: 'worker.js',
      durable_objects: { bindings: [{ name: 'COUNTER' }] },
    }),
    /class_name.*required/i,
  );
});

test('rejects unsupported migration keys by name', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'counter',
      main: 'worker.js',
      migrations: [{ tag: 'v1', deleted_classes: ['Counter'] }],
    }),
    /unknown migrations\[0\] key.*deleted_classes/i,
  );
});

test('accepts exact pipeline bindings', () => {
  assert.deepEqual(parseWranglerManifest({
    name: 'stream-worker',
    main: 'worker.js',
    durable_objects: { bindings: [{ name: 'OBJECTS', class_name: 'Object' }] },
    pipelines: [{ binding: 'STREAM', stream: 'stream-id' }],
  }), {
    name: 'stream-worker',
    main: 'worker.js',
    compatibility_flags: [],
    bindings: [{ name: 'OBJECTS', class_name: 'Object' }],
    migrations: [],
    vars: {},
    pipelines: [{ binding: 'STREAM', stream: 'stream-id' }],
  });
});

test('accepts exact service bindings', () => {
  const manifest = parseWranglerManifest({
    name: 'catalog',
    main: 'worker.js',
    services: [{ binding: 'ICEBERG_COMMIT', service: 'verglas-runtime' }],
  });
  assert.deepEqual(manifest.services, [
    { binding: 'ICEBERG_COMMIT', service: 'verglas-runtime' },
  ]);
});

test('accepts the Cloudflare Vectorize binding shape', () => {
  const manifest = parseWranglerManifest({
    name: 'search-worker',
    main: 'worker.js',
    vectorize: [{ binding: 'VECTORIZE', index_name: 'documents' }],
  });
  assert.deepEqual(manifest.vectorize, [
    { binding: 'VECTORIZE', index_name: 'documents' },
  ]);
});

test('rejects malformed Vectorize bindings and cross-kind duplicate names', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'search-worker',
      main: 'worker.js',
      vectorize: [{ binding: 'VECTORIZE', index_name: 'documents', dimensions: 3 }],
    }),
    /unknown vectorize\[0\] key.*dimensions/i,
  );
  assert.throws(
    () => parseWranglerManifest({
      name: 'search-worker',
      main: 'worker.js',
      pipelines: [{ binding: 'VECTORIZE', stream: 'events' }],
      vectorize: [{ binding: 'VECTORIZE', index_name: 'documents' }],
    }),
    /duplicate binding name.*VECTORIZE/i,
  );
});

test('accepts the Verglas Graph binding shape', () => {
  const manifest = parseWranglerManifest({
    name: 'graph-worker',
    main: 'worker.js',
    graphs: [{ binding: 'GRAPH', graph_name: 'knowledge' }],
  });
  assert.deepEqual(manifest.graphs, [
    { binding: 'GRAPH', graph_name: 'knowledge' },
  ]);
});

test('rejects malformed Graph bindings and cross-kind duplicate names', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'graph-worker',
      main: 'worker.js',
      graphs: [{ binding: 'GRAPH', graph_name: 'knowledge', recursive: true }],
    }),
    /unknown graphs\[0\] key.*recursive/i,
  );
  assert.throws(
    () => parseWranglerManifest({
      name: 'graph-worker',
      main: 'worker.js',
      vectorize: [{ binding: 'GRAPH', index_name: 'documents' }],
      graphs: [{ binding: 'GRAPH', graph_name: 'knowledge' }],
    }),
    /duplicate binding name.*GRAPH/i,
  );
});

test('accepts the Verglas Query binding shape', () => {
  const manifest = parseWranglerManifest(base({
    queries: [{ binding: 'ANALYTICS', query_name: 'sales' }],
  }));
  assert.deepEqual(manifest.queries, [{ binding: 'ANALYTICS', query_name: 'sales' }]);
});

test('rejects malformed Query bindings and cross-kind duplicate names', () => {
  assert.throws(() => parseWranglerManifest(base({
    queries: [{ binding: 'ANALYTICS', query_name: 'sales', extra: true }],
  })), /unknown queries\[0\] key: extra/u);
  assert.throws(() => parseWranglerManifest(base({
    pipelines: [{ binding: 'ANALYTICS', stream: 'events' }],
    queries: [{ binding: 'ANALYTICS', query_name: 'sales' }],
  })), /duplicate binding name: ANALYTICS/u);
});

test('rejects the unsupported Skill binding', () => {
  assert.throws(() => parseWranglerManifest(base({
    skills: [{ binding: 'FANTASY_DRAFT', skill_name: 'fantasy-draft' }],
  })), /unknown top-level key: skills/u);
});

test('rejects malformed services and cross-kind duplicate binding names', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'catalog',
      main: 'worker.js',
      services: [{ binding: 'ICEBERG_COMMIT', service: 'verglas-runtime', extra: true }],
    }),
    /unknown services\[0\] key.*extra/i,
  );
  assert.throws(
    () => parseWranglerManifest({
      name: 'catalog',
      main: 'worker.js',
      durable_objects: { bindings: [{ name: 'ICEBERG_COMMIT', class_name: 'Catalog' }] },
      services: [{ binding: 'ICEBERG_COMMIT', service: 'verglas-runtime' }],
    }),
    /duplicate binding name.*ICEBERG_COMMIT/i,
  );
});

test('rejects unknown pipeline keys and duplicate binding names', () => {
  assert.throws(
    () => parseWranglerManifest({
      name: 'stream-worker',
      main: 'worker.js',
      pipelines: [{ binding: 'STREAM', stream: 'stream-id', extra: true }],
    }),
    /unknown pipelines\[0\] key.*extra/i,
  );
  assert.throws(
    () => parseWranglerManifest({
      name: 'stream-worker',
      main: 'worker.js',
      durable_objects: { bindings: [{ name: 'STREAM', class_name: 'Object' }] },
      pipelines: [{ binding: 'STREAM', stream: 'stream-id' }],
    }),
    /duplicate binding name.*STREAM/i,
  );
});
