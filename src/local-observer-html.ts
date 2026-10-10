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
  // Public render input must obey the same provenance states as the producer.
  const freshObserved = input.provenance === 'observed' && input.freshness === 'FRESH';
  if ((input.provenance === 'synthetic'
        && (input.freshness !== 'UNKNOWN' || input.observed_at !== null))
      || (input.provenance === 'cached' && input.freshness !== 'STALE')
      || (freshObserved && input.observed_at === null)
      || (!freshObserved && input.capacity.available !== null)) return false;
  // The producer reports synthetic freshness as UNKNOWN even when its original
  // source was STALE; that runner may retain the truthful STALE reason.
  const noncurrentReasons = input.provenance === 'synthetic'
    ? ['UNKNOWN', 'STALE']
    : [input.provenance === 'cached' || input.freshness === 'STALE' ? 'STALE' : 'UNKNOWN'];
  const ids = new Set<string>();
  for (const runner of input.runners) {
    if (!record(runner, ['id', 'status', 'reason', 'heartbeat_at', 'last_outcome'])
        || typeof runner.id !== 'string' || !/^runner-[0-9a-f]{3,48}$/.test(runner.id)
        || ids.has(runner.id) || !oneOf(runner.status, STATUS)
        || !oneOf(runner.reason, REASONS) || !timestamp(runner.heartbeat_at)
        || !oneOf(runner.last_outcome, OUTCOMES)
        || (runner.heartbeat_at !== null && input.observed_at !== null
            && Date.parse(runner.heartbeat_at) > Date.parse(input.observed_at))
        || (runner.status === 'READY'
            && (runner.reason !== 'NONE'
                || !freshRunnerHeartbeat(input.observed_at, runner.heartbeat_at)))
        || (!freshObserved && (runner.status !== 'UNKNOWN'
            || !noncurrentReasons.includes(runner.reason) || runner.last_outcome !== 'UNKNOWN'))) return false;
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
// Match runner.ts heartbeatHealth's 90-second stale threshold relative to this observation.
function freshRunnerHeartbeat(observed: string | null, heartbeat: string | null): boolean {
  return observed !== null && heartbeat !== null
    && Date.parse(observed) - Date.parse(heartbeat) <= 90_000;
}

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

/**
 * A cheap, depth-bounded shape guard before structuredClone. Never traverses unknown
 * object graphs, invokes getters, or copies oversized strings/arrays. Semantic
 * validation still happens on the isolated clone in valid().
 */
type BoundedVisit = (value: unknown, depth: number) => boolean;

function boundedArray(value: unknown[], depth: number, visit: BoundedVisit): boolean {
  if (value.length > 40 || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry || !('value' in entry) || !visit(entry.value, depth + 1)) return false;
  }
  return true;
}

function boundedRecord(value: object, depth: number, visit: BoundedVisit): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 7) return false;
  for (const key of keys) {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !entry?.enumerable || !('value' in entry)
        || !visit(entry.value, depth + 1)) return false;
  }
  return true;
}

function boundedForClone(input: unknown): boolean {
  const seen = new Set<object>();
  const visit: BoundedVisit = (value, depth) => {
    if (value === null) return true;
    if (typeof value === 'string') return value.length <= 120;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || depth > 3 || seen.has(value)) return false;
    seen.add(value);
    return Array.isArray(value)
      ? boundedArray(value, depth, visit)
      : boundedRecord(value, depth, visit);
  };
  return visit(input, 0);
}

function observerStatus(item: LocalObserverViewV1 | null, trustworthy: boolean): string {
  if (item === null) return 'UNKNOWN: snapshot inválido';
  if (!trustworthy) return `NO LIVE · ${item.provenance.toUpperCase()} · ${item.freshness}`;
  return 'OBSERVED · FRESH reportado · SIN VALIDACIÓN EN PRODUCCIÓN';
}

/** Never claims live readiness. Invalid/ambiguous input produces an honest UNKNOWN document. */
export function renderLocalObserverHtml(input: unknown): string {
  let item: LocalObserverViewV1 | null = null;
  try {
    // Reject over-budget or accessor-based inputs before cloning any data.
    // All HTML values then come exclusively from a separately validated clone.
    if (!boundedForClone(input)) throw new TypeError('Invalid snapshot');
    const snapshot: unknown = structuredClone(input);
    if (valid(snapshot)) item = snapshot;
  } catch { /* uncloneable input never reaches output */ }
  const trustworthy = item !== null && item.provenance === 'observed' && item.freshness === 'FRESH'
    && item.observed_at !== null;
  const status = observerStatus(item, trustworthy);
  const availableForDisplay = trustworthy && item !== null ? item.capacity.available : null;
  const rows = item?.runners.map((runner) => {
    const state = `${runner.status} (reportado)`;
    return `<tr><th scope="row">${escapeText(runner.id)}</th><td>${escapeText(state)}</td><td>${escapeText(runner.reason)}</td><td>${escapeText(runner.last_outcome)}</td><td>${escapeText(runner.heartbeat_at ?? 'UNKNOWN')}</td></tr>`;
  }).join('') ?? '';
  const empty = rows ? '' : '<p role="status">No hay runners verificables en este snapshot. Estado UNKNOWN.</p>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FactoryRunner · Observador local</title><style>${STYLE}</style></head><body><main>
<header><h1>FactoryRunner · Observador local</h1><p class="warning" role="status">${escapeText(status)}</p><p>Panel estático de lectura. Sin acciones, sin conexión, sin certificación de producción.</p><p>Observado: ${escapeText(item?.observed_at ?? 'UNKNOWN')}</p></header>
<section aria-labelledby="summary"><h2 id="summary">Capacidad y cola</h2><div class="summary"><div>Capacidad total<span class="value">${metric(item?.capacity.total ?? null)}</span></div><div>Capacidad disponible<span class="value">${metric(availableForDisplay)}</span></div><div>En espera / bloqueados<span class="value">${metric(item?.queue.pending ?? null)} / ${metric(item?.queue.blocked ?? null)}</span></div></div></section>
<section aria-labelledby="runners"><h2 id="runners">Runners</h2>${empty}<div class="table-wrap" role="region" aria-label="Tabla de runners, desplazable en pantallas pequeñas" tabindex="0"><table><caption>Estado, motivo, último resultado y heartbeat</caption><thead><tr><th scope="col">Runner</th><th scope="col">Estado</th><th scope="col">Motivo</th><th scope="col">Resultado</th><th scope="col">Heartbeat (UTC)</th></tr></thead><tbody>${rows}</tbody></table></div></section>
</main></body></html>`;
}
