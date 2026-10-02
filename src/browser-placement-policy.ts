import type { BrowserPlacementProfile } from './browser-placement-profile.ts';
import {
  browserRemoteProfile,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserPlacement = 'HOST_LOCAL' | 'REMOTE_BINDING' | 'BLOCKED_UNKNOWN';
export type BrowserPlacementReason =
  | 'LOCAL_CAPACITY_PROVEN'
  | 'EXACT_REMOTE_BINDING'
  | 'UNKNOWN_CAPACITY'
  | 'REMOTE_BINDING_NOT_EXACT';

export type BrowserPlacementDecision = {
  version: 1;
  authority: 'unchanged';
  runner_id: string;
  profile_fingerprint: string;
  placement: BrowserPlacement;
  reason: BrowserPlacementReason;
  binding_fingerprint: string | null;
  fingerprint: string;
};

type DecisionCore = Omit<BrowserPlacementDecision, 'fingerprint'>;

const PROFILE_KEYS = [
  'version',
  'authority',
  'runner_id',
  'observed_at',
  'host_local_proven',
  'remote_capable_proven',
  'status',
  'identity_fingerprint',
  'resource_fingerprint',
  'manifest_fingerprint',
  'evidence_fingerprint',
  'fingerprint',
] as const;

const REMOTE_PROFILE_KEYS = [
  'version',
  'authority',
  'runner_id',
  'location',
  'capability',
  'remote_alias',
  'fingerprint',
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} inválido.`);
  return value;
}

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(`${field} inválido.`);
  return parsed;
}

function canonicalProfile(input: unknown): BrowserPlacementProfile {
  const record = asRecord(input, 'BrowserPlacementProfile');
  exactKeys(record, PROFILE_KEYS, 'BrowserPlacementProfile');

  if (record.version !== 1 || record.authority !== 'unchanged') {
    throw new TypeError('BrowserPlacementProfile no es canónico.');
  }

  const hostLocal = booleanValue(record.host_local_proven, 'host_local_proven');
  const remoteCapable = booleanValue(record.remote_capable_proven, 'remote_capable_proven');
  const status = stringValue(record.status, 'status', 16);
  const expectedStatus = hostLocal || remoteCapable ? 'KNOWN' : 'UNKNOWN';
  if (status !== expectedStatus) {
    throw new TypeError('BrowserPlacementProfile status incoherente.');
  }

  const core = {
    version: 1 as const,
    authority: 'unchanged' as const,
    runner_id: uuid(record.runner_id, 'runner_id'),
    observed_at: integer(record.observed_at, 'observed_at'),
    host_local_proven: hostLocal,
    remote_capable_proven: remoteCapable,
    status: expectedStatus,
    identity_fingerprint: sha256(record.identity_fingerprint, 'identity_fingerprint'),
    resource_fingerprint: sha256(record.resource_fingerprint, 'resource_fingerprint'),
    manifest_fingerprint: sha256(record.manifest_fingerprint, 'manifest_fingerprint'),
    evidence_fingerprint: sha256(record.evidence_fingerprint, 'evidence_fingerprint'),
  };
  const fingerprint = sha256(record.fingerprint, 'fingerprint');
  if (fingerprint !== stableSha256(core)) {
    throw new TypeError('BrowserPlacementProfile fingerprint incoherente.');
  }

  return Object.freeze({ ...core, fingerprint });
}

function canonicalRemoteBindings(input: unknown): readonly BrowserRemoteProfile[] {
  if (!Array.isArray(input)) throw new TypeError('remote_bindings debe ser un arreglo.');

  return input.map((value, index) => {
    const record = asRecord(value, `remote_bindings[${index}]`);
    exactKeys(record, REMOTE_PROFILE_KEYS, `remote_bindings[${index}]`);
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
  });
}

function decision(
  profile: BrowserPlacementProfile,
  placement: BrowserPlacement,
  reason: BrowserPlacementReason,
  bindingFingerprint: string | null,
): BrowserPlacementDecision {
  const core: DecisionCore = {
    version: 1,
    authority: 'unchanged',
    runner_id: profile.runner_id,
    profile_fingerprint: profile.fingerprint,
    placement,
    reason,
    binding_fingerprint: bindingFingerprint,
  };
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function browserPlacementPolicy(
  profileInput: unknown,
  remoteBindingsInput: unknown = [],
): BrowserPlacementDecision {
  const profile = canonicalProfile(profileInput);

  if (profile.status === 'UNKNOWN') {
    return decision(profile, 'BLOCKED_UNKNOWN', 'UNKNOWN_CAPACITY', null);
  }

  if (profile.host_local_proven) {
    return decision(profile, 'HOST_LOCAL', 'LOCAL_CAPACITY_PROVEN', null);
  }

  if (!profile.remote_capable_proven) {
    return decision(profile, 'BLOCKED_UNKNOWN', 'UNKNOWN_CAPACITY', null);
  }

  const bindings = canonicalRemoteBindings(remoteBindingsInput);
  if (
    bindings.length !== 1
    || bindings[0].runner_id !== profile.runner_id
  ) {
    return decision(profile, 'BLOCKED_UNKNOWN', 'REMOTE_BINDING_NOT_EXACT', null);
  }

  return decision(
    profile,
    'REMOTE_BINDING',
    'EXACT_REMOTE_BINDING',
    bindings[0].fingerprint,
  );
}
