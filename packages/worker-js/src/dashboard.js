//! Stateless semantic JSX renderer for bounded Query-backed dashboards.

const MAX_ROWS = 120;
const MAX_COLUMNS = 24;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** JSX factory. */
export function h(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; }

/** Semantic dashboard root component. */
export const Dashboard = component('dashboard');
/** Semantic layout grid component. */
export const Grid = component('grid');
/** Semantic card component. */
export const Card = component('card');
/** Query-backed single-value component. */
export const Metric = component('metric');
/** Query-backed bounded table component. */
export const DataTable = component('table');
/** Query-backed bounded bar chart component. */
export const BarChart = component('bar');
/** Query-backed bounded line chart component. */
export const LineChart = component('line');

/** Creates a stateless Worker that renders one semantic dashboard per request. */
export function createDashboard({ title, render }) {
  if (typeof title !== 'string' || typeof render !== 'function') throw new TypeError('Dashboard title and render function are required');
  return Object.freeze({
    async fetch(request, env) {
      if ((request.method ?? 'GET').toUpperCase() !== 'GET') return new Response('method not allowed', { status: 405 });
      try {
        const body = await renderNode(await render(request, env), env);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><header><h1>${escapeHtml(title)}</h1></header><main>${body}</main></body></html>`;
        if (new TextEncoder().encode(html).length > MAX_RESPONSE_BYTES) throw new Error('dashboard response exceeds byte ceiling');
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'" } });
      } catch (error) {
        return new Response(`Dashboard render failed: ${error instanceof Error ? error.message : 'unknown error'}`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    },
  });
}

/** Creates an opaque semantic component marker. */
function component(kind) { const value = (props) => ({ kind, props }); value.dashboardKind = kind; return value; }

/** Renders a semantic node and resolves its Query data on demand. */
async function renderNode(node, env) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (!node || typeof node !== 'object' || !node.type?.dashboardKind) throw new TypeError('Dashboard accepts only semantic components');
  const kind = node.type.dashboardKind;
  const props = node.props ?? {};
  const children = (await Promise.all((node.children ?? []).map((child) => renderNode(child, env)))).join('');
  if (kind === 'dashboard') return `<section class="dashboard">${children}</section>`;
  if (kind === 'grid') return `<section class="grid">${children}</section>`;
  if (kind === 'card') return `<section class="card"><h2>${escapeHtml(props.title ?? '')}</h2>${children}</section>`;
  const rows = await queryRows(props.query, env);
  if (rows.length > MAX_ROWS) throw new Error(`query result exceeds ${MAX_ROWS} row ceiling`);
  if (kind === 'metric') return `<section class="metric"><span>${escapeHtml(props.label ?? '')}</span><strong>${escapeHtml(rows[0]?.[props.field] ?? '—')}</strong></section>`;
  if (kind === 'table') return renderTable(rows, props.columns);
  if (kind === 'bar' || kind === 'line') return renderChart(rows, props.x, props.y, kind);
  throw new TypeError(`unknown Dashboard component: ${kind}`);
}

/** Runs a declared Query endpoint. */
async function queryRows(query, env) {
  if (!query || typeof query.binding !== 'string' || typeof query.endpoint !== 'string') throw new TypeError('component query is required');
  const binding = env?.[query.binding];
  if (!binding || typeof binding.query !== 'function') throw new Error(`Query binding ${query.binding} is unavailable`);
  const result = await binding.query(query.endpoint, query.params ?? {});
  if (!result || !Array.isArray(result.rows)) throw new Error('Query returned an invalid result');
  return result.rows;
}

/** Renders a bounded data table. */
function renderTable(rows, columns) {
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) throw new Error(`table columns must contain 1-${MAX_COLUMNS} entries`);
  const head = columns.map((column) => `<th>${escapeHtml(column.label ?? column.key)}</th>`).join('');
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row?.[column.key] ?? '')}</td>`).join('')}</tr>`).join('');
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Renders a compact SVG chart without client-side JavaScript. */
function renderChart(rows, x, y, kind) {
  if (typeof x !== 'string' || typeof y !== 'string') throw new TypeError('chart x and y fields are required');
  const values = rows.map((row) => Number(row?.[y]));
  if (values.some((value) => !Number.isFinite(value))) throw new Error('chart values must be finite numbers');
  const maximum = Math.max(1, ...values);
  const width = 640; const height = 240; const slot = width / Math.max(1, rows.length);
  const marks = kind === 'bar'
    ? values.map((value, index) => { const hgt = (value / maximum) * 190; return `<rect x="${index * slot + 4}" y="${210 - hgt}" width="${Math.max(1, slot - 8)}" height="${hgt}"/>`; }).join('')
    : `<polyline points="${values.map((value, index) => `${index * slot + slot / 2},${210 - (value / maximum) * 190}`).join(' ')}"/>`;
  const labels = rows.map((row, index) => `<text x="${index * slot + slot / 2}" y="232">${escapeHtml(row?.[x] ?? '')}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${marks}${labels}</svg>`;
}

/** Escapes text before placing it in HTML or SVG. */
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

const STYLE = 'body{margin:0;padding:24px;background:#f5f7fa;color:#172033;font:14px system-ui}main{max-width:1200px;margin:auto}.dashboard,.grid{display:grid;gap:16px}.grid{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.card,.metric,.table,svg{background:white;border:1px solid #dfe4ec;border-radius:10px;padding:16px}.metric{display:grid;gap:8px}.metric strong{font-size:30px}.table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e8ebf0}svg{width:100%;height:auto}rect{fill:#5271ff}polyline{fill:none;stroke:#5271ff;stroke-width:3}text{text-anchor:middle;font-size:10px;fill:#596579}';
