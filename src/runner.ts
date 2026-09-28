import { asRecord, exactKeys, integer, ref, semver, slug, uuid } from './validation.ts';

export type RunnerIdentity = {
  version: 1;
  runner_id: string;
  protocol_version: 1;
  runtime: string;
  runtime_version: string;
  platform: string;
  location: string;
  capabilities: string[];
  max_parallel: number;
};

export type RunnerHeartbeat = {
  version: 1;
  runner_id: string;
  sequence: number;
  observed_at: number;
  status: 'ready' | 'busy' | 'draining' | 'offline';
  capacity: { max: number; active: number };
  active_sessions: string[];
};

const IDENTITY_KEYS = ['version','runner_id','protocol_version','runtime','runtime_version','platform','location','capabilities','max_parallel'] as const;
const HEARTBEAT_KEYS = ['version','runner_id','sequence','observed_at','status','capacity','active_sessions'] as const;
const HEARTBEAT_STATUSES = new Set(['ready','busy','draining','offline']);

export function parseRunnerIdentity(input: unknown): RunnerIdentity {
  const record = asRecord(input, 'RunnerIdentity');
  exactKeys(record, IDENTITY_KEYS, 'RunnerIdentity');
  if (record.version !== 1 || record.protocol_version !== 1) throw new TypeError('Versión de RunnerIdentity no soportada.');
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0 || record.capabilities.length > 64) {
    throw new TypeError('Capabilities inválidas.');
  }
  const capabilities = record.capabilities.map((value) => slug(value, 'Capability'));
  if (new Set(capabilities).size !== capabilities.length) throw new TypeError('Capabilities duplicadas.');
  capabilities.sort();
  return {
    version: 1,
    runner_id: uuid(record.runner_id, 'runner_id'),
    protocol_version: 1,
    runtime: slug(record.runtime, 'runtime'),
    runtime_version: semver(record.runtime_version, 'runtime_version'),
    platform: slug(record.platform, 'platform'),
    location: slug(record.location, 'location'),
    capabilities,
    max_parallel: integer(record.max_parallel, 'max_parallel', 1, 64),
  };
}

export function parseRunnerHeartbeat(input: unknown): RunnerHeartbeat {
  const record = asRecord(input, 'RunnerHeartbeat');
  exactKeys(record, HEARTBEAT_KEYS, 'RunnerHeartbeat');
  if (record.version !== 1) throw new TypeError('Versión de RunnerHeartbeat no soportada.');
  if (typeof record.status !== 'string' || !HEARTBEAT_STATUSES.has(record.status)) throw new TypeError('Estado de heartbeat inválido.');
  const capacity = asRecord(record.capacity, 'capacity');
  exactKeys(capacity, ['max','active'], 'capacity');
  const max = integer(capacity.max, 'capacity.max', 1, 64);
  const active = integer(capacity.active, 'capacity.active', 0, max);
  if (!Array.isArray(record.active_sessions) || record.active_sessions.length > 64) {
    throw new TypeError('active_sessions inválidas.');
  }
  const activeSessions = record.active_sessions.map((value) => ref(value, 'active_session', 160));
  if (new Set(activeSessions).size !== activeSessions.length || activeSessions.length > active) {
    throw new TypeError('active_sessions inconsistentes.');
  }
  activeSessions.sort();
  return {
    version: 1,
    runner_id: uuid(record.runner_id, 'runner_id'),
    sequence: integer(record.sequence, 'sequence'),
    observed_at: integer(record.observed_at, 'observed_at'),
    status: record.status as RunnerHeartbeat['status'],
    capacity: { max, active },
    active_sessions: activeSessions,
  };
}

export function heartbeatHealth(
  heartbeat: RunnerHeartbeat | null,
  now: number,
  staleAfterSeconds = 90,
  offlineAfterSeconds = 300,
): 'healthy' | 'stale' | 'offline' {
  integer(now, 'now');
  integer(staleAfterSeconds, 'staleAfterSeconds', 1);
  integer(offlineAfterSeconds, 'offlineAfterSeconds', staleAfterSeconds + 1);
  if (heartbeat === null || heartbeat.status === 'offline') return 'offline';
  if (heartbeat.observed_at > now) return 'offline';
  const age = now - heartbeat.observed_at;
  if (age > offlineAfterSeconds) return 'offline';
  if (age > staleAfterSeconds) return 'stale';
  return 'healthy';
}

export function assertHeartbeatMatchesIdentity(identity: RunnerIdentity, heartbeat: RunnerHeartbeat): void {
  if (heartbeat.runner_id !== identity.runner_id) throw new TypeError('Heartbeat pertenece a otro runner.');
  if (heartbeat.capacity.max !== identity.max_parallel) throw new TypeError('Capacidad del heartbeat no coincide con RunnerIdentity.');
}

export function availableCapacity(heartbeat: RunnerHeartbeat | null, now: number): number {
  if (heartbeat === null || heartbeatHealth(heartbeat, now) !== 'healthy' || heartbeat.status === 'draining') return 0;
  return heartbeat.capacity.max - heartbeat.capacity.active;
}
