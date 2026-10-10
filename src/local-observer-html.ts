/**
 * FactoryRunner #467: offline, read-only rendering of the Local Observer v1 view.
 * No network, scripts, imports, storage, privileges or actuation.
 * The sibling #466 can supply this view shape through a separately reviewed adapter.
 */
export type LocalObserverViewV1 = {
  version: 1;
  provenance: 'synthetic' | 'cached' | 'observed';
  freshness: 'FRESH' | 'STALE' | 'UNKNOWN';
  observed_at: string | null;
  capacity: { total: number | null; available: number | null };
  queue: { pending: number | null; blocked: number | null };
  runners: Array<{
    id: string;
    status: 'READY' | 'WAITING' | 'BLOCKED' | 'OFFLINE' | 'UNKNOWN';
    reason: 'NONE' | 'NO_CAPACITY' | 'DEPENDENCY' | 'CLAIMS' | 'HUMAN_GATE' | 'STALE' | 'UNKNOWN';
    heartbeat_at: string | null;
    last_outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  }>;
};

type Data = Record<string, unknown>;
const SOURCES = ['synthetic', 'cached', 'observed'];
const FRESHNESS = ['FRESH', 'STALE', 'UNKNOWN'];
const STATUS = ['READY', 'WAITING', 'BLOCKED', 'OFFLINE', 'UNKNOWN'];
const REASONS = ['NONE', 'NO_CAPACITY', 'DEPENDENCY', 'CLAIMS', 'HUMAN_GATE', 'STALE', 'UNKNOWN'];
const OUTCOMES = ['SUCCESS', 'FAILURE', 'UNKNOWN'];

function record(value: unknown, keys: readonly string[]): value is Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function oneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}
function count(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 1_000_000);
}
function timestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().replace('.000', '') === value);
}
function valid(input: unknown): input is LocalObserverViewV1 {
  if (!record(input, ['version', 'provenance', 'freshness', 'observed_at', 'capacity', 'queue', 'runners'])
      || input.version !== 1 || !oneOf(input.provenance, SOURCES)
      || !oneOf(input.freshness, FRESHNESS) || !timestamp(input.observed_at)
      || !record(input.capacity, ['total', 'available'])
      || !record(input.queue, ['pending', 'blocked'])
      || !count(input.capacity.total) || !count(input.capacity.available)
      || !count(input.queue.pending) || !count(input.queue.blocked)
      || !Array.isArray(input.runners) || input.runners.length > 40) return false;
  if (input.capacity.available !== null && input.capacity.total !== null
      && input.capacity.available > input.capacity.total) return false;
  const ids = new Set<string>();
  for (const runner of input.runners) {
    if (!record(runner, ['id', 'status', 'reason', 'heartbeat_at', 'last_outcome'])
        || typeof runner.id !== 'string' || runner.id.length < 1 || runner.id.length > 120
        || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(runner.id)
        || ids.has(runner.id) || !oneOf(runner.status, STATUS)
        || !oneOf(runner.reason, REASONS) || !timestamp(runner.heartbeat_at)
        || !oneOf(runner.last_outcome, OUTCOMES)) return false;
    ids.add(runner.id);
  }
  return true;
}
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (part) => ESCAPES[part] ?? '&#xfffd;');
}
function metric(value: number | null): string { return value === null ? 'UNKNOWN' : String(value); }

const STYLE = `
:root{font-family:system-ui,-apple-system,sans-serif;color:#eef1f5;background:#10141b;color-scheme:dark}
*{box-sizing:border-box}body{margin:0}main{width:min(100%,80rem);margin:auto;padding:1rem}
h1{font-size:clamp(1.5rem,4vw,2.3rem);line-height:1.2}h2{font-size:1.1rem}
p,td,th,caption{overflow-wrap:anywhere}p{line-height:1.6}
header,section{border:1px solid #677489;border-radius:.65rem;padding:1rem;margin-block:1rem}
.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem}
.summary>div{border:1px solid #677489;border-radius:.4rem;padding:.75rem;min-width:0}
.value{display:block;font-weight:700;font-size:1.2rem;margin-top:.5rem}
.warning{font-weight:700;border-inline-start:.35rem solid #e2ad56;padding-inline-start:.75rem}
.table-wrap{max-width:100%;overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}
caption{text-align:left;margin-bottom:.6rem}th,td{padding:.7rem;border-bottom:1px solid #677489}
.table-wrap:focus-visible{outline:3px solid #d8a95b;outline-offset:2px}
@media(max-width:600px){main{padding:.65rem}header,section{padding:.7rem}.summary{grid-template-columns:1fr}table{min-width:36rem}}
@media(min-width:601px){.summary{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;

/** Never claims live readiness. Invalid/ambiguous input produces an honest UNKNOWN document. */
export function renderLocalObserverHtml(input: unknown): string {
  let item: LocalObserverViewV1 | null = null;
  try {
    // Clone first: accessors/Proxies cannot change a value after validation.
    // A non-cloneable or ambiguous value is rendered as UNKNOWN.
    const snapshot: unknown = structuredClone(input);
    if (valid(snapshot)) item = snapshot;
  } catch { /* uncloneable input never reaches output */ }
  const trustworthy = item !== null && item.provenance === 'observed' && item.freshness === 'FRESH'
    && item.observed_at !== null;
  const status = item === null ? 'UNKNOWN: snapshot inválido'
    : !trustworthy ? `NO LIVE · ${item.provenance.toUpperCase()} · ${item.freshness}`
      : 'OBSERVED · FRESH reportado · SIN VALIDACIÓN EN PRODUCCIÓN';
  const rows = item?.runners.map((runner) => {
    const state = !trustworthy && runner.status === 'READY'
      ? 'READY (dato no verificado)' : `${runner.status} (reportado)`;
    return `<tr><th scope="row">${escapeText(runner.id)}</th><td>${escapeText(state)}</td><td>${escapeText(runner.reason)}</td><td>${escapeText(runner.last_outcome)}</td><td>${escapeText(runner.heartbeat_at ?? 'UNKNOWN')}</td></tr>`;
  }).join('') ?? '';
  const empty = rows ? '' : '<p role="status">No hay runners verificables en este snapshot. Estado UNKNOWN.</p>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FactoryRunner · Observador local</title><style>${STYLE}</style></head><body><main>
<header><h1>FactoryRunner · Observador local</h1><p class="warning" role="status">${escapeText(status)}</p><p>Panel estático de lectura. Sin acciones, sin conexión, sin certificación de producción.</p><p>Observado: ${escapeText(item?.observed_at ?? 'UNKNOWN')}</p></header>
<section aria-labelledby="summary"><h2 id="summary">Capacidad y cola</h2><div class="summary"><div>Capacidad total<span class="value">${metric(item?.capacity.total ?? null)}</span></div><div>Capacidad disponible<span class="value">${metric(item?.capacity.available ?? null)}</span></div><div>En espera / bloqueados<span class="value">${metric(item?.queue.pending ?? null)} / ${metric(item?.queue.blocked ?? null)}</span></div></div></section>
<section aria-labelledby="runners"><h2 id="runners">Runners</h2>${empty}<div class="table-wrap" role="region" aria-label="Tabla de runners, desplazable en pantallas pequeñas" tabindex="0"><table><caption>Estado, motivo, último resultado y heartbeat</caption><thead><tr><th scope="col">Runner</th><th scope="col">Estado</th><th scope="col">Motivo</th><th scope="col">Resultado</th><th scope="col">Heartbeat (UTC)</th></tr></thead><tbody>${rows}</tbody></table></div></section>
</main></body></html>`;
}
