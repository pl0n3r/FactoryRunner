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
  // Opaque hexadecimal aliases only: user-entered labels or addresses cannot escape.
  return typeof value === 'string' && /^runner-[0-9a-f]{3,48}$/.test(value);
}
function unknownView(): LocalObserverViewV1 {
  return { version: 1, provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
    capacity: { total: null, available: null }, queue: { pending: null, blocked: null }, runners: [] };
}

/** Parse only canonical primitive runner fields; never call untrusted getters. */
function parseRunners(values: unknown[], observed: string | null): LocalObserverViewV1['runners'] | null {
  const ids = new Set<string>();
  const runners: LocalObserverViewV1['runners'] = [];
  for (let n = 0; n < values.length; n++) {
    const cell = Object.getOwnPropertyDescriptor(values, String(n));
    if (!cell || !('value' in cell)) return null;
    const runner = fields(cell.value, RUNNER_KEYS);
    if (!runner || !safeRunnerId(runner.id) || ids.has(runner.id)
        || !listed(runner.status, STATUS) || !listed(runner.reason, REASONS)
        || !utc(runner.heartbeat_at) || !listed(runner.last_outcome, OUTCOMES)
        || (runner.heartbeat_at !== null && observed !== null
            && Date.parse(runner.heartbeat_at) > Date.parse(observed))) return null;
    ids.add(runner.id);
    runners.push({id: runner.id, status: runner.status, reason: runner.reason,
      heartbeat_at: runner.heartbeat_at, last_outcome: runner.last_outcome});
  }
  return runners;
}

function readyDowngradeReason(reason: LocalObserverViewV1['runners'][number]['reason'], stale: boolean) {
  if (reason !== 'NONE') return reason;
  return stale ? 'STALE' as const : 'UNKNOWN' as const;
}
function normalizedFreshness(source: LocalObserverViewV1['provenance'], freshness: LocalObserverViewV1['freshness']) {
  if (source === 'synthetic') return 'UNKNOWN';
  return source === 'cached' ? 'STALE' : freshness;
}
function noncurrentReason(source: LocalObserverViewV1['provenance'], freshness: LocalObserverViewV1['freshness']) {
  if (source === 'synthetic') return 'UNKNOWN';
  return source === 'cached' || freshness === 'STALE' ? 'STALE' : 'UNKNOWN';
}

/**
 * Produces only primitive copies from an exact, size-bounded allowlist. Invalid,
 * hostile, ambiguous or accessor-based data becomes a constant UNKNOWN view.
 * Stale/synthetic/cached input may describe history, never current readiness.
 */
export function projectLocalObserverSnapshot(input: unknown): LocalObserverViewV1 {
  try {
    const root = fields(input, ROOT_KEYS);
    if (root?.version !== 1 || !listed(root.provenance, SOURCE)
        || !listed(root.freshness, FRESH) || !utc(root.observed_at)) return unknownView();
    const capacity = fields(root.capacity, ['total', 'available']);
    const queue = fields(root.queue, ['pending', 'blocked']);
    if (!capacity || !queue || !counter(capacity.total) || !counter(capacity.available)
        || !counter(queue.pending) || !counter(queue.blocked)
        || (capacity.total !== null && capacity.available !== null && capacity.available > capacity.total)
        || !Array.isArray(root.runners) || root.runners.length > 40
        || Reflect.ownKeys(root.runners).length !== root.runners.length + 1) return unknownView();

    const observed = root.observed_at;
    const source = root.provenance;
    const freshness = root.freshness;
    if (root.provenance === 'observed' && root.freshness === 'FRESH' && observed === null) return unknownView();
    const runners = parseRunners(root.runners, observed);
    if (runners === null) return unknownView();
    // A claimed fresh snapshot without an observed source is not current evidence.
    const trustedAsCurrent = root.provenance === 'observed' && root.freshness === 'FRESH';
    // The runtime's heartbeatHealth() considers >90 seconds stale. Measure
    // relative to observed_at (not Date.now) so offline tests stay deterministic.
    // A global FRESH claim never overrides individual runner freshness.
    const reportedRunners = runners.map((runner) => {
      const missingHeartbeat = runner.heartbeat_at === null;
      const staleHeartbeat = !missingHeartbeat && observed !== null
        && Date.parse(observed) - Date.parse(runner.heartbeat_at!) > 90_000;
      if (trustedAsCurrent && runner.status === 'READY'
          && (missingHeartbeat || staleHeartbeat || runner.reason !== 'NONE')) {
        return {...runner, status: 'UNKNOWN' as const,
          reason: readyDowngradeReason(runner.reason, staleHeartbeat),
          last_outcome: 'UNKNOWN' as const};
      }
      return runner;
    });
    // Aggregate availability is unsafe to display when a claimed READY runner
    // had to be downgraded. Preserve the total as historical metadata, but
    // refuse a misleading positive available count until sources reconcile.
    const readinessDowngraded = runners.some((runner, index) =>
      runner.status === 'READY' && reportedRunners[index].status !== 'READY');
    return {
      version: 1,
      provenance: root.provenance,
      freshness: normalizedFreshness(source, freshness),
      observed_at: root.provenance === 'synthetic' ? null : observed,
      capacity: {total: capacity.total,
        available: trustedAsCurrent && !readinessDowngraded ? capacity.available : null},
      queue: {pending: queue.pending, blocked: queue.blocked},
      runners: reportedRunners.map((runner) => trustedAsCurrent ? runner : {
        ...runner, status: 'UNKNOWN' as const,
        reason: noncurrentReason(source, freshness),
        last_outcome: 'UNKNOWN' as const,
      }),
    };
  } catch {
    // Proxy traps, invalid descriptors and hostile data must not leak or throw.
    return unknownView();
  }
}
