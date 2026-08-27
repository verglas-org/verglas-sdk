/**
 * Cloudflare Vectorize V2 Worker binding over the declared cross-component
 * fetch capability. The binding has one fixed index identity and no namespace
 * or direct network fallback.
 */

import { unwrapResult } from './transport-core.js';

const ORIGIN = 'https://verglas.internal/vectorize';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A fixed Cloudflare-shaped Vectorize index binding. */
export class VectorizeIndex {
  /** @param {string} bindingName @param {string} indexName @param {object} transport */
  constructor(bindingName, indexName, transport) {
    if (typeof bindingName !== 'string' || bindingName.trim() === '') {
      throw new TypeError('Vectorize binding name must be a non-empty string');
    }
    if (typeof indexName !== 'string' || indexName.trim() === '') {
      throw new TypeError('Vectorize index name must be a non-empty string');
    }
    if (!transport || typeof transport.doFetch !== 'function') {
      throw new TypeError('Vectorize binding requires the WIT bindings.do-fetch transport');
    }
    this.#bindingName = bindingName;
    this.#indexName = indexName;
    this.#transport = transport;
    Object.freeze(this);
  }

  #bindingName;
  #indexName;
  #transport;

  /** Inserts vectors without replacing existing ids. */
  async insert(vectors) {
    return this.#post('insert', { vectors: normalizeVectors(vectors) });
  }

  /** Inserts or fully replaces vectors by id. */
  async upsert(vectors) {
    return this.#post('upsert', { vectors: normalizeVectors(vectors) });
  }

  /** Queries by an explicit vector. */
  async query(vector, options = {}) {
    return this.#post('query', { vector: normalizeValues(vector), ...normalizeOptions(options) });
  }

  /** Queries using the stored vector for one id. */
  async queryById(id, options = {}) {
    return this.#post('query-by-id', { id: normalizeId(id), ...normalizeOptions(options) });
  }

  /** Gets complete vectors for the requested ids. */
  async getByIds(ids) {
    return this.#post('get-by-ids', { ids: normalizeIds(ids) });
  }

  /** Deletes vectors for the requested ids. */
  async deleteByIds(ids) {
    return this.#post('delete-by-ids', { ids: normalizeIds(ids) });
  }

  /** Returns immutable index configuration and durable progress. */
  async describe() {
    return this.#post('describe', {});
  }

  /** Sends one canonical JSON request through the declared binding. */
  async #post(operation, payload) {
    const raw = await this.#transport.doFetch(this.#bindingName, this.#indexName, {
      method: 'POST',
      uri: `${ORIGIN}/${operation}`,
      headers: [['content-type', 'application/json']],
      body: encoder.encode(JSON.stringify(payload)),
      ws: undefined,
    });
    const response = unwrapResult(raw, 'bindings.do-fetch');
    const status = Number(response?.status);
    let body;
    try {
      body = JSON.parse(decoder.decode(response?.body ?? new Uint8Array()));
    } catch (error) {
      throw new Error(`Vectorize ${operation} returned invalid JSON: ${error.message}`);
    }
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      const detail = body && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : `HTTP ${String(response?.status)}`;
      throw new Error(`Vectorize ${operation} failed: ${detail}`);
    }
    return body;
  }
}

/** Creates one fixed Vectorize index binding. */
export function createVectorizeBinding(bindingName, indexName, transport) {
  return new VectorizeIndex(bindingName, indexName, transport);
}

/** Normalizes a batch without accepting values JSON would silently rewrite. */
function normalizeVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new TypeError('Vectorize insert and upsert require a non-empty vector array');
  }
  return vectors.map((vector) => {
    if (!vector || typeof vector !== 'object' || Array.isArray(vector)) {
      throw new TypeError('Vectorize vectors must be objects');
    }
    const normalized = {
      id: normalizeId(vector.id),
      values: normalizeValues(vector.values),
    };
    if (vector.namespace !== undefined) normalized.namespace = normalizeNamespace(vector.namespace);
    if (vector.metadata !== undefined) {
      assertJsonValue(vector.metadata, new WeakSet());
      normalized.metadata = vector.metadata;
    }
    return normalized;
  });
}

/** Converts supported array and typed-array values to finite JavaScript numbers. */
function normalizeValues(values) {
  if (!Array.isArray(values) && !(values instanceof Float32Array) && !(values instanceof Float64Array)) {
    throw new TypeError('Vectorize values must be a number array, Float32Array, or Float64Array');
  }
  const normalized = Array.from(values);
  if (normalized.length === 0 || normalized.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError('Vectorize values must contain one or more finite numbers');
  }
  return normalized;
}

/** Validates one Cloudflare vector identifier. */
function normalizeId(id) {
  if (typeof id !== 'string' || id.length === 0 || encoder.encode(id).byteLength > 64) {
    throw new TypeError('Vectorize id must be a non-empty string of at most 64 bytes');
  }
  return id;
}

/** Validates one optional Vectorize namespace. */
function normalizeNamespace(namespace) {
  if (typeof namespace !== 'string' || namespace.length === 0 || encoder.encode(namespace).byteLength > 64) {
    throw new TypeError('Vectorize namespace must be a non-empty string of at most 64 bytes');
  }
  return namespace;
}

/** Validates a bounded non-empty id list. */
function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
    throw new TypeError('Vectorize ids must contain between 1 and 1000 identifiers');
  }
  return ids.map(normalizeId);
}

/** Copies only the current Cloudflare query option names. */
function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Vectorize query options must be an object');
  }
  const allowed = new Set(['topK', 'returnValues', 'returnMetadata', 'namespace', 'filter']);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`unknown Vectorize query option: ${key}`);
  }
  const normalized = {};
  if (options.topK !== undefined) {
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100) {
      throw new RangeError('Vectorize topK must be an integer between 1 and 100');
    }
    normalized.topK = options.topK;
  }
  if (options.returnValues !== undefined) normalized.returnValues = Boolean(options.returnValues);
  if (options.returnMetadata !== undefined) {
    if (!['none', 'indexed', 'all'].includes(options.returnMetadata)) {
      throw new TypeError('Vectorize returnMetadata must be none, indexed, or all');
    }
    normalized.returnMetadata = options.returnMetadata;
  }
  if (options.namespace !== undefined) normalized.namespace = normalizeNamespace(options.namespace);
  if (options.filter !== undefined) {
    assertJsonValue(options.filter, new WeakSet());
    normalized.filter = options.filter;
  }
  return normalized;
}

/** Rejects values that cannot cross the JSON binding contract exactly. */
function assertJsonValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError('Vectorize JSON numbers must be finite');
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('Vectorize metadata and filters must be acyclic JSON values');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Vectorize metadata and filters must contain plain objects');
    }
    for (const entry of Object.values(value)) assertJsonValue(entry, ancestors);
  }
  ancestors.delete(value);
}
