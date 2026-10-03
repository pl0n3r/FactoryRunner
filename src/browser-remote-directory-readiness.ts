import {
  browserRemoteProfile,
  type BrowserRemoteCapability,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import type { BrowserRemoteDirectorySnapshot } from './browser-remote-directory-snapshot.ts';
import {
  assertHeartbeatMatchesIdentity,
  availableCapacity,
  heartbeatHealth,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from './runner.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  stringValue,
} from './validation.ts';

type HeartbeatHealth = 'healthy' | 'stale' | 'offline' | 'unknown';

export type BrowserRemoteDirectoryReadiness = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'ready' | 'unavailable';
  runner_id: string | null;
  location: string | null;
  snapshot_fingerprint: string | null;
  heartbeat_sequence: number | null;
  heartbeat_observed_at: number | null;
  heartbeat_health: HeartbeatHealth;
  available_capacity: number;
  capabilities: readonly BrowserRemoteCapability[];
  fingerprint: string;
}>;

type BrowserRemoteDirectoryReadinessCore = Omit<
  BrowserRemoteDirectoryReadiness,
  'fingerprint'
>;

const SNAPSHOT_KEYS = [
  'version',
  'authority',
  'size',
  'profiles',
  'fingerprint',
] as const;

const PROFILE_KEYS = [
  'version',
  'authority',
  'runner_id',
  'location',
  'capability',
  'remote_alias',
  'fingerprint',
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalProfile(value: unknown): BrowserRemoteProfile {
  const record = asRecord(value, 'BrowserRemoteProfile');
  exactKeys(record, PROFILE_KEYS, 'BrowserRemoteProfile');

  const canonical = browserRemoteProfile({
    version: record.version,
    runner_id: record.runner_id,
    location: record.location,
    capability: record.capability,
    remote_alias: record.remote_alias,
  });
  if (
    record.authority !== canonical.authority
    || record.fingerprint !== canonical.fingerprint
  ) {
    throw new TypeError('BrowserRemoteProfile no es canónico.');
  }
  return canonical;
}

function canonicalSnapshot(value: unknown): BrowserRemoteDirectorySnapshot {
  const record = asRecord(value, 'BrowserRemoteDirectorySnapshot');
  exactKeys(record, SNAPSHOT_KEYS, 'BrowserRemoteDirectorySnapshot');
  if (record.version !== 1 || record.authority !== 'unchanged') {
    throw new TypeError('BrowserRemoteDirectorySnapshot inválido.');
  }
  if (!Array.isArray(record.profiles)) {
    throw new TypeError('BrowserRemoteDirectorySnapshot profiles inválidos.');
  }

  const profiles = record.profiles.map((profile) => canonicalProfile(profile));
  const size = integer(record.size, 'snapshot.size', 0, 4096);
  if (profiles.length !== size) {
    throw new TypeError('BrowserRemoteDirectorySnapshot size incoherente.');
  }

  const aliases = profiles.map((profile) => profile.remote_alias);
  const ordered = [...aliases].sort(compareText);
  if (aliases.some((alias, index) => alias !== ordered[index])) {
    throw new TypeError('BrowserRemoteDirectorySnapshot no está ordenado.');
  }

  const fingerprint = stringValue(
    record.fingerprint,
    'snapshot.fingerprint',
    64,
  );
  if (!SHA256_RE.test(fingerprint)) {
    throw new TypeError('BrowserRemoteDirectorySnapshot fingerprint inválido.');
  }

  const canonicalProfiles = Object.freeze(profiles);
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    size,
    profiles: canonicalProfiles,
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserRemoteDirectorySnapshot fingerprint incoherente.');
  }

  return Object.freeze({ ...core, fingerprint });
}

function verdict(
  core: BrowserRemoteDirectoryReadinessCore,
): BrowserRemoteDirectoryReadiness {
  return Object.freeze({
    ...core,
    capabilities: Object.freeze([...core.capabilities]),
    fingerprint: stableSha256(core),
  });
}

function unavailable(
  partial: Partial<BrowserRemoteDirectoryReadinessCore> = {},
): BrowserRemoteDirectoryReadiness {
  return verdict({
    version: 1,
    authority: 'unchanged',
    status: 'unavailable',
    runner_id: null,
    location: null,
    snapshot_fingerprint: null,
    heartbeat_sequence: null,
    heartbeat_observed_at: null,
    heartbeat_health: 'unknown',
    available_capacity: 0,
    capabilities: [],
    ...partial,
    status: 'unavailable',
    available_capacity: 0,
    capabilities: [],
  });
}

export function browserRemoteDirectoryReadiness(
  identityInput: unknown,
  heartbeatInput: unknown,
  snapshotInput: unknown,
  nowInput: unknown,
): BrowserRemoteDirectoryReadiness {
  let runnerId: string | null = null;
  let location: string | null = null;
  let snapshotFingerprint: string | null = null;

  try {
    const identity = parseRunnerIdentity(identityInput);
    runnerId = identity.runner_id;
    location = identity.location;

    const heartbeat = parseRunnerHeartbeat(heartbeatInput);
    assertHeartbeatMatchesIdentity(identity, heartbeat);

    const snapshot = canonicalSnapshot(snapshotInput);
    snapshotFingerprint = snapshot.fingerprint;

    const now = integer(nowInput, 'now');
    const health = heartbeatHealth(heartbeat, now);
    const capacity = availableCapacity(identity, heartbeat, now);

    const identityCapabilities = new Set(identity.capabilities);
    const capabilities = Array.from(
      new Set(
        snapshot.profiles
          .filter(
            (profile) =>
              profile.runner_id === identity.runner_id
              && profile.location === identity.location
              && identityCapabilities.has(profile.capability),
          )
          .map((profile) => profile.capability),
      ),
    ).sort(compareText);

    const ready = (
      health === 'healthy'
      && heartbeat.status !== 'draining'
      && capacity > 0
      && capabilities.length > 0
    );

    if (!ready) {
      return unavailable({
        runner_id: runnerId,
        location,
        snapshot_fingerprint: snapshotFingerprint,
        heartbeat_sequence: heartbeat.sequence,
        heartbeat_observed_at: heartbeat.observed_at,
        heartbeat_health: health,
      });
    }

    return verdict({
      version: 1,
      authority: 'unchanged',
      status: 'ready',
      runner_id: runnerId,
      location,
      snapshot_fingerprint: snapshotFingerprint,
      heartbeat_sequence: heartbeat.sequence,
      heartbeat_observed_at: heartbeat.observed_at,
      heartbeat_health: health,
      available_capacity: capacity,
      capabilities,
    });
  } catch {
    return unavailable({
      runner_id: runnerId,
      location,
      snapshot_fingerprint: snapshotFingerprint,
    });
  }
}
