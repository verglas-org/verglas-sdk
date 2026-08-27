/**
 * Fixed named Graph binding over the declared cross-component fetch capability.
 * The binding exposes bounded property-graph operations without a namespace or
 * direct network fallback.
 */

import { unwrapResult } from './transport-core.js';

const ORIGIN = 'https://verglas.internal/graph';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A fixed Verglas Graph binding. */
export class Graph {
  /** @param {string} bindingName @param {string} graphName @param {object} transport */
  constructor(bindingName, graphName, transport) {
    this.#bindingName = nonemptyString(bindingName, 'Graph binding name');
    this.#graphName = nonemptyString(graphName, 'Graph name');
    if (!transport || typeof transport.doFetch !== 'function') {
      throw new TypeError('Graph binding requires the WIT bindings.do-fetch transport');
    }
    this.#transport = transport;
    Object.freeze(this);
  }

  #bindingName;
  #graphName;
  #transport;

  /** Inserts or fully replaces nodes by id. */
  async upsertNodes(nodes) {
    return this.#post('upsert-nodes', { nodes: normalizeNodes(nodes) });
  }

  /** Inserts or fully replaces edges by id. */
  async upsertEdges(edges) {
    return this.#post('upsert-edges', { edges: normalizeEdges(edges) });
  }

  /** Gets nodes in caller id order. */
  async getNodes(ids) {
    return this.#post('get-nodes', { ids: normalizeIds(ids) });
  }

  /** Gets edges in caller id order. */
  async getEdges(ids) {
    return this.#post('get-edges', { ids: normalizeIds(ids) });
  }

  /** Deletes nodes and their incident edges atomically. */
  async deleteNodes(ids) {
    return this.#post('delete-nodes', { ids: normalizeIds(ids) });
  }

  /** Deletes edges by id. */
  async deleteEdges(ids) {
    return this.#post('delete-edges', { ids: normalizeIds(ids) });
  }

  /** Traverses a bounded neighborhood from one node. */
  async neighbors(id, options = {}) {
    return this.#post('neighbors', { id: normalizeId(id), ...normalizeTraversalOptions(options, false) });
  }

  /** Finds one deterministic bounded unweighted shortest path. */
  async shortestPath(from, to, options = {}) {
    return this.#post('shortest-path', {
      from: normalizeId(from),
      to: normalizeId(to),
      ...normalizeTraversalOptions(options, true),
    });
  }

  /** Returns immutable graph identity and durable counts. */
  async describe() {
    return this.#post('describe', {});
  }

  /** Sends one JSON request through the declared binding. */
  async #post(operation, payload) {
    const raw = await this.#transport.doFetch(this.#bindingName, this.#graphName, {
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
      throw new Error(`Graph ${operation} returned invalid JSON: ${error.message}`);
    }
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      const detail = body && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : `HTTP ${String(response?.status)}`;
      throw new Error(`Graph ${operation} failed: ${detail}`);
    }
    return body;
  }
}

/** Creates one fixed named Graph binding. */
export function createGraphBinding(bindingName, graphName, transport) {
  return new Graph(bindingName, graphName, transport);
}

/** Validates and copies one non-empty batch of nodes. */
function normalizeNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 1000) {
    throw new TypeError('Graph nodes must contain between 1 and 1000 entries');
  }
  return nodes.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError('Graph nodes must be objects');
    rejectUnknownKeys(node, new Set(['id', 'kind', 'properties']), 'node');
    const normalized = { id: normalizeId(node.id), kind: normalizeKind(node.kind) };
    if (node.properties !== undefined) {
      assertJsonObject(node.properties, 'Graph node properties');
      normalized.properties = node.properties;
    }
    return normalized;
  });
}

/** Validates and copies one non-empty batch of edges. */
function normalizeEdges(edges) {
  if (!Array.isArray(edges) || edges.length < 1 || edges.length > 1000) {
    throw new TypeError('Graph edges must contain between 1 and 1000 entries');
  }
  return edges.map((edge) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError('Graph edges must be objects');
    rejectUnknownKeys(edge, new Set(['id', 'from', 'to', 'kind', 'weight', 'properties']), 'edge');
    const normalized = {
      id: normalizeId(edge.id),
      from: normalizeId(edge.from),
      to: normalizeId(edge.to),
      kind: normalizeKind(edge.kind),
    };
    if (edge.weight !== undefined) {
      if (typeof edge.weight !== 'number' || !Number.isFinite(edge.weight)) throw new TypeError('Graph edge weight must be finite');
      normalized.weight = edge.weight;
    }
    if (edge.properties !== undefined) {
      assertJsonObject(edge.properties, 'Graph edge properties');
      normalized.properties = edge.properties;
    }
    return normalized;
  });
}

/** Copies the supported traversal options and enforces public ceilings. */
function normalizeTraversalOptions(options, shortest) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Graph traversal options must be an object');
  }
  const allowed = new Set(shortest
    ? ['direction', 'edgeKinds', 'maxDepth', 'nodeFilter', 'edgeFilter']
    : ['direction', 'edgeKinds', 'depth', 'limit', 'returnNodes', 'returnEdges', 'nodeFilter', 'edgeFilter']);
  rejectUnknownKeys(options, allowed, 'traversal option');
  const normalized = {};
  if (options.direction !== undefined) {
    if (!['out', 'in', 'both'].includes(options.direction)) throw new TypeError('Graph direction must be out, in, or both');
    normalized.direction = options.direction;
  }
  if (options.edgeKinds !== undefined) {
    if (!Array.isArray(options.edgeKinds) || options.edgeKinds.length < 1 || options.edgeKinds.length > 20) {
      throw new TypeError('Graph edgeKinds must contain between 1 and 20 kinds');
    }
    normalized.edgeKinds = options.edgeKinds.map(normalizeKind);
  }
  const depthName = shortest ? 'maxDepth' : 'depth';
  if (options[depthName] !== undefined) {
    if (!Number.isInteger(options[depthName]) || options[depthName] < 1 || options[depthName] > 8) {
      throw new RangeError(`Graph ${depthName} must be an integer between 1 and 8`);
    }
    normalized[depthName] = options[depthName];
  }
  if (!shortest && options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw new RangeError('Graph limit must be an integer between 1 and 1000');
    }
    normalized.limit = options.limit;
  }
  if (!shortest && options.returnNodes !== undefined) normalized.returnNodes = Boolean(options.returnNodes);
  if (!shortest && options.returnEdges !== undefined) normalized.returnEdges = Boolean(options.returnEdges);
  for (const field of ['nodeFilter', 'edgeFilter']) {
    if (options[field] !== undefined) {
      assertJsonObject(options[field], `Graph ${field}`);
      normalized[field] = options[field];
    }
  }
  return normalized;
}

/** Validates a bounded non-empty id array. */
function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000) {
    throw new TypeError('Graph ids must contain between 1 and 1000 identifiers');
  }
  return ids.map(normalizeId);
}

/** Validates one external graph identifier. */
function normalizeId(id) {
  const value = nonemptyString(id, 'Graph id');
  if (encoder.encode(value).byteLength > 64) throw new TypeError('Graph id must be at most 64 bytes');
  return value;
}

/** Validates one node or edge kind. */
function normalizeKind(kind) {
  const value = nonemptyString(kind, 'Graph kind');
  if (encoder.encode(value).byteLength > 64) throw new TypeError('Graph kind must be at most 64 bytes');
  return value;
}

/** Validates a required non-empty string. */
function nonemptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Rejects keys outside one exact public record shape. */
function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new TypeError(`unknown Graph ${label} key: ${key}`);
  }
}

/** Validates a plain JSON object with finite numeric values. */
function assertJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  assertJsonValue(value, new WeakSet(), label);
}

/** Recursively validates one JSON-compatible value. */
function assertJsonValue(value, ancestors, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${label} numbers must be finite`);
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError(`${label} must be acyclic JSON`);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain objects`);
  }
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) assertJsonValue(entry, ancestors, label);
  ancestors.delete(value);
}
