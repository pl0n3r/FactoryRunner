/** #488: pure pre-live projection of caller-supplied, typed runner exports.
 *
 * This module DOES NOT collect a runtime source, read the host, serve HTTP or
 * certify production/live health. A FRESH candidate is NOT a READY runner.
 */
import { heartbeatHealth, parseRunnerHeartbeat } from './runner.ts';
import { projectSyntheticObserverFromExports } from './local-observer-source-adapter.ts';

export type RuntimeObserverCandidateV1 = Readonly<{
  version: 1;
  kind: 'in_process_candidate';
  sample_freshness: 'FRESH' | 'STALE' | 'OFFLINE' | 'UNKNOWN';
  readiness: 'UNKNOWN';
  runner_alias: string | null;
  runner_status: 'ready' | 'busy' | 'draining' | 'offline' | 'UNKNOWN';
  heartbeat_age_seconds: number | null;
  capacity: Readonly<{ total: number | null; available: null }>;
  queue: Readonly<{ pending: null; blocked: null }>;
  last_outcome: 'UNKNOWN';
}>;

const SNAPSHOT_KEYS = [
  'version', 'runner_id', 'observed_at', 'heartbeat_sequence',
  'runner_status', 'max_parallel', 'active', 'available',
  'queued_orders', 'dispatchable_orders',
] as const;
const HEARTBEAT_KEYS = [
  'version', 'runner_id', 'sequence', 'observed_at', 'status',
  'capacity', 'active_sessions',
] as const;
const MAX_UNIX_SECONDS = 253402300799;

function integer(value: unknown, max = 1_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= max;
}

/** Descriptor copies reject getters, extra properties and exotic prototypes. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) return null;
  const owned = Reflect.ownKeys(value);
  if (owned.length !== keys.length || owned.some(k => typeof k !== 'string' || !keys.includes(k))) {
    return null;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d)) return null;
    out[key] = d.value as unknown;
  }
  return out;
}
function refs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64
      || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const result: string[] = [];
  for (let n = 0; n < value.length; n++) {
    const d = Object.getOwnPropertyDescriptor(value, String(n));
    if (!d || !('value' in d) || typeof d.value !== 'string') return null;
    result.push(d.value as string);
  }
  return result;
}
function candidate(
  freshness: RuntimeObserverCandidateV1['sample_freshness'] = 'UNKNOWN',
  alias: string | null = null,
  status: RuntimeObserverCandidateV1['runner_status'] = 'UNKNOWN',
  age: number | null = null,
  total: number | null = null,
): RuntimeObserverCandidateV1 {
  return Object.freeze({
    version: 1 as const,
    kind: 'in_process_candidate' as const,
    sample_freshness: freshness,
    readiness: 'UNKNOWN' as const,
    runner_alias: alias,
    runner_status: status,
    heartbeat_age_seconds: age,
    capacity: Object.freeze({total, available: null}),
    queue: Object.freeze({pending: null, blocked: null}),
    last_outcome: 'UNKNOWN' as const,
  });
}

/**
 * The caller must inject exports and a trustworthy clock explicitly.
 * Even valid exports are *untrusted candidates*; no real collector is wired.
 * previousSequence, when provided, must be strictly smaller than heartbeat.
 */
export function projectInProcessObserverCandidate(
  snapshotInput: unknown,
  heartbeatInput: unknown,
  nowSeconds: unknown,
  previousSequence?: unknown,
): RuntimeObserverCandidateV1 {
  try {
    if (!integer(nowSeconds, MAX_UNIX_SECONDS)
        || (previousSequence !== undefined && !integer(previousSequence, MAX_UNIX_SECONDS))) {
      return candidate();
    }
    const snapshot = record(snapshotInput, SNAPSHOT_KEYS);
    const source = record(heartbeatInput, HEARTBEAT_KEYS);
    if (!snapshot || !source) return candidate();
    const capacity = record(source.capacity, ['max', 'active']);
    const sessions = refs(source.active_sessions);
    if (!capacity || !sessions) return candidate();
    const hb = parseRunnerHeartbeat({...source, capacity: {...capacity}, active_sessions: sessions});
    if (snapshot.version !== 1 || snapshot.runner_id !== hb.runner_id
        || snapshot.observed_at !== hb.observed_at
        || snapshot.heartbeat_sequence !== hb.sequence
        || snapshot.runner_status !== hb.status
        || snapshot.max_parallel !== hb.capacity.max
        || snapshot.active !== hb.capacity.active
        || !integer(snapshot.available, 64)
        || !integer(snapshot.queued_orders)
        || !integer(snapshot.dispatchable_orders)
        || snapshot.available > hb.capacity.max - hb.capacity.active
        || snapshot.dispatchable_orders
          !== Math.min(snapshot.available, snapshot.queued_orders as number)
        || (previousSequence !== undefined && hb.sequence <= previousSequence)
        || hb.observed_at > nowSeconds) return candidate();
    const age = nowSeconds - hb.observed_at;
    const health = heartbeatHealth(hb, nowSeconds);
    if (health === 'offline') return candidate('OFFLINE', null, 'UNKNOWN', age, hb.capacity.max);
    if (health === 'stale') return candidate('STALE', null, 'UNKNOWN', age, hb.capacity.max);
    const expectedAvailable = hb.status === 'draining'
      ? 0 : hb.capacity.max - hb.capacity.active;
    if (snapshot.available !== expectedAvailable) return candidate();
    // Reuse strict existing projection for an opaque, declassified alias.
    const safe = projectSyntheticObserverFromExports(
      snapshotInput, heartbeatInput, nowSeconds,
    );
    if (safe.runners.length !== 1) return candidate();
    return candidate('FRESH', safe.runners[0].id, hb.status, age, hb.capacity.max);
  } catch {
    // No exception, private error message or raw source may escape.
    return candidate();
  }
}
