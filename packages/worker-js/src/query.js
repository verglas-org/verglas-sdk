//! Client binding for Verglas Query materializations.

import { requestToRecord, responseFromRecord } from './http.js';

/** Creates a fixed-identity Query binding over the declared binding ABI. */
export function createQueryBinding(bindingName, queryName, transport) {
  if (typeof bindingName !== 'string' || bindingName.length === 0) throw new TypeError('Query binding is required');
  if (typeof queryName !== 'string' || queryName.length === 0) throw new TypeError('Query name is required');
  const call = async (path, body) => {
    const request = await requestToRecord(`https://verglas.internal${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = responseFromRecord(await transport.doFetch(bindingName, queryName, request));
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Query request failed with status ${response.status}`);
    return value;
  };
  return Object.freeze({
    /** Runs one declared, bounded endpoint. */
    async query(endpoint, params = {}) {
      if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('Query endpoint is required');
      if (!isJsonObject(params) || !jsonRoundTrips(params)) throw new TypeError('Query params must be a JSON object');
      return call('/query/run', { endpoint, params });
    },
    /** Describes the materialization and its current source watermarks. */
    async describe() { return call('/query/describe', {}); },
  });
}

/** Returns whether a value is a non-array object. */
function isJsonObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Rejects values such as undefined that JSON would silently discard. */
function jsonRoundTrips(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return false;
  if (Array.isArray(value)) return value.every(jsonRoundTrips);
  if (value && typeof value === 'object') return Object.values(value).every(jsonRoundTrips);
  return Number.isNaN(value) === false && value !== Infinity && value !== -Infinity;
}
