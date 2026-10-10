/**
 * FactoryRunner #466 — bounded, purely local projection for the read-only observer.
 * No network, secrets, orders, persistence, clock inference or external effects.
 * The output shape matches #467's explicitly versioned HTML renderer input.
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

type Values = Record<string, unknown>;
const SOURCE = ['synthetic', 'cached', 'observed'] as const;
const FRESH = ['FRESH', 'STALE', 'UNKNOWN'] as const;
const STATUS = ['READY', 'WAITING', 'BLOCKED', 'OFFLINE', 'UNKNOWN'] as const;
const REASONS = ['NONE', 'NO_CAPACITY', 'DEPENDENCY', 'CLAIMS', 'HUMAN_GATE', 'STALE', 'UNKNOWN'] as const;
const OUTCOMES = ['SUCCESS', 'FAILURE', 'UNKNOWN'] as const;
const ROOT_KEYS = ['version', 'provenance', 'freshness', 'observed_at', 'capacity', 'queue', 'runners'];
const RUNNER_KEYS = ['id', 'status', 'reason', 'heartbeat_at', 'last_outcome'];

/** Read descriptors only: no getters, prototype access or second reads of untrusted values. */
function fields(value: unknown, expected: readonly string[]): Values | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((k) => typeof k !== 'string' || !expected.includes(k))) return null;
  const result: Values = Object.create(null) as Values;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function listed<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
function counter(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000);
}
function utc(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000', '') === value);
}
function safeRunnerId(value: unknown): value is string {
  return typeof value === 'string' && /^runner-[A-Za-z0-9_-]{1,48}$/.test(value)
    && !/(?:secret|token|cookie|password|bearer|github_pat|gh[pousr]_|sk[-_]|mail|email)/i.test(value);
}
function unknownView(): LocalObserverViewV1 {
  return { version: 1, provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
    capacity: { total: null, available: null }, queue: { pending: null, blocked: null }, runners: [] };
}

/**
 * Produces only primitive copies from an exact, size-bounded allowlist. Invalid,
 * hostile, ambiguous or accessor-based data becomes a constant UNKNOWN view.
 * Stale/synthetic/cached input may describe history, never current readiness.
 */
export function projectLocalObserverSnapshot(input: unknown): LocalObserverViewV1 {
  try {
    const root = fields(input, ROOT_KEYS);
    if (!root || root.version !== 1 || !listed(root.provenance, SOURCE)
        || !listed(root.freshness, FRESH) || !utc(root.observed_at)) return unknownView();
    const capacity = fields(root.capacity, ['total', 'available']);
    const queue = fields(root.queue, ['pending', 'blocked']);
    if (!capacity || !queue || !counter(capacity.total) || !counter(capacity.available)
        || !counter(queue.pending) || !counter(queue.blocked)
        || (capacity.total !== null && capacity.available !== null && capacity.available > capacity.total)
        || !Array.isArray(root.runners) || root.runners.length > 40
        || Reflect.ownKeys(root.runners).length !== root.runners.length + 1) return unknownView();

    const observed = root.observed_at;
    if (root.provenance === 'observed' && root.freshness === 'FRESH' && observed === null) return unknownView();
    const ids = new Set<string>();
    const runners: LocalObserverViewV1['runners'] = [];
    for (let n = 0; n < root.runners.length; n++) {
      const cell = Object.getOwnPropertyDescriptor(root.runners, String(n));
      if (!cell || !('value' in cell)) return unknownView();
      const r = fields(cell.value, RUNNER_KEYS);
      if (!r || !safeRunnerId(r.id) || ids.has(r.id)
          || !listed(r.status, STATUS) || !listed(r.reason, REASONS)
          || !utc(r.heartbeat_at) || !listed(r.last_outcome, OUTCOMES)
          || (r.heartbeat_at !== null && observed !== null && Date.parse(r.heartbeat_at) > Date.parse(observed))) return unknownView();
      ids.add(r.id);
      runners.push({id: r.id, status: r.status, reason: r.reason,
        heartbeat_at: r.heartbeat_at, last_outcome: r.last_outcome});
    }
    // A claimed fresh snapshot without an observed source is not current evidence.
    const trustedAsCurrent = root.provenance === 'observed' && root.freshness === 'FRESH';
    return {
      version: 1,
      provenance: root.provenance,
      freshness: root.provenance === 'synthetic' ? 'UNKNOWN'
        : root.provenance === 'cached' ? 'STALE' : root.freshness,
      observed_at: root.provenance === 'synthetic' ? null : observed,
      capacity: {total: capacity.total, available: trustedAsCurrent ? capacity.available : null},
      queue: {pending: queue.pending, blocked: queue.blocked},
      runners: runners.map((runner) => trustedAsCurrent ? runner : {
        ...runner, status: 'UNKNOWN' as const,
        reason: root.freshness === 'STALE' || root.provenance === 'cached' ? 'STALE' as const : 'UNKNOWN' as const,
        last_outcome: 'UNKNOWN' as const,
      }),
    };
  } catch {
    // Proxy traps, invalid descriptors and hostile data must not leak or throw.
    return unknownView();
  }
}
