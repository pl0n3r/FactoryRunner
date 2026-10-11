/**
 * FactoryRunner #478: offline/synthetic-only adapter for pre-existing exports.
 * This is a PURE fixture bridge, not a collector, runtime reader or live source.
 * Never infer a global queue or last outcome from runner-local capacity.
 */
import { createHash } from 'node:crypto';
import { heartbeatHealth, parseRunnerHeartbeat } from './runner.ts';
import { projectLocalObserverSnapshot, type LocalObserverViewV1 } from './local-observer-snapshot.ts';

const CAPACITY_KEYS = [
  'version', 'runner_id', 'observed_at', 'heartbeat_sequence',
  'runner_status', 'max_parallel', 'active', 'available',
  'queued_orders', 'dispatchable_orders',
] as const;
const HEARTBEAT_KEYS = [
  'version', 'runner_id', 'sequence', 'observed_at', 'status',
  'capacity', 'active_sessions',
] as const;

/** Descriptor-only bounded copies. Accessors, symbols and exotic prototypes fail closed. */
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const owned = Reflect.ownKeys(value);
  if (owned.length !== keys.length || owned.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return null;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function bounded(value: unknown, maximum = 1_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Clone only an array's own primitive cells; never iterate untrusted getters. */
function sessionRefs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) {
    return null;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return null;
    result.push(descriptor.value as string);
  }
  return result;
}

function unknown(): LocalObserverViewV1 {
  return projectLocalObserverSnapshot(null);
}

/**
 * Project a deterministic fixture built from capacitySnapshot() and a matching
 * RunnerHeartbeat with an explicit wall-clock second. Even a healthy historical
 * fixture remains synthetic/UNKNOWN: this method has no observation authority.
 */
export function projectSyntheticObserverFromExports(
  snapshotInput: unknown, heartbeatInput: unknown, nowInput: unknown,
): LocalObserverViewV1 {
  try {
    const snapshot = fields(snapshotInput, CAPACITY_KEYS);
    const source = fields(heartbeatInput, HEARTBEAT_KEYS);
    if (!snapshot || !source || !bounded(nowInput, 253402300799)) return unknown();
    const hbCapacity = fields(source.capacity, ['max', 'active']);
    const activeSessions = sessionRefs(source.active_sessions);
    if (!hbCapacity || activeSessions === null) return unknown();
    const heartbeat = parseRunnerHeartbeat({
      ...source, capacity: {...hbCapacity}, active_sessions: activeSessions,
    });
    if (snapshot.version !== 1 || snapshot.runner_id !== heartbeat.runner_id
        || snapshot.observed_at !== heartbeat.observed_at
        || snapshot.heartbeat_sequence !== heartbeat.sequence
        || snapshot.runner_status !== heartbeat.status
        || snapshot.max_parallel !== heartbeat.capacity.max
        || snapshot.active !== heartbeat.capacity.active
        || !bounded(snapshot.max_parallel, 64) || snapshot.max_parallel < 1
        || !bounded(snapshot.active, 64)
        || !bounded(snapshot.available, 64)
        || !bounded(snapshot.queued_orders)
        || !bounded(snapshot.dispatchable_orders)
        || heartbeat.observed_at > nowInput) return unknown();

    const health = heartbeatHealth(heartbeat, nowInput);
    const expectedAvailable = health === 'healthy' && heartbeat.status !== 'draining'
      ? heartbeat.capacity.max - heartbeat.capacity.active : 0;
    if (snapshot.available !== expectedAvailable
        || snapshot.dispatchable_orders !== Math.min(expectedAvailable, snapshot.queued_orders as number)) {
      return unknown();
    }

    const runnerAlias = 'runner-' + createHash('sha256').update(heartbeat.runner_id).digest('hex').slice(0, 12);
    const heartbeatIso = new Date(heartbeat.observed_at * 1000).toISOString().replace('.000Z', 'Z');
    const view = {
      version: 1, provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
      capacity: {total: snapshot.max_parallel, available: null},
      queue: {pending: null, blocked: null},
      runners: [{id: runnerAlias, status: 'UNKNOWN', reason: 'UNKNOWN',
        heartbeat_at: heartbeatIso, last_outcome: 'UNKNOWN'}],
    };
    return projectLocalObserverSnapshot(view);
  } catch {
    // No exception details or untrusted raw evidence may escape the adapter.
    return unknown();
  }
}
