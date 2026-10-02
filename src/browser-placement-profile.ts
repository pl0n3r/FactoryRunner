import { capabilityManifest } from './capability-manifest.ts';
import { parseRunnerIdentity } from './runner.ts';
import type { RunnerIdentity } from './runner.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  uuid,
} from './validation.ts';

export type BrowserPlacementProfile = {
  version: 1;
  authority: 'unchanged';
  runner_id: string;
  observed_at: number;
  host_local_proven: boolean;
  remote_capable_proven: boolean;
  status: 'KNOWN' | 'UNKNOWN';
  identity_fingerprint: string;
  resource_fingerprint: string;
  manifest_fingerprint: string;
  evidence_fingerprint: string;
  fingerprint: string;
};

type BrowserPlacementProfileCore = Omit<BrowserPlacementProfile, 'fingerprint'>;

type ParsedResource = {
  runner_id: string;
  observed_at: number;
  fingerprint: string;
};

type ParsedCapabilityEvidence = {
  runner_id: string;
  observed_at: number;
  host_local_proven: boolean;
  remote_capable_proven: boolean;
  manifest_fingerprint: string;
  evidence_fingerprint: string;
};

const RESOURCE_KEYS = [
  'version',
  'runner_id',
  'observed_at',
  'heartbeat_sequence',
  'runner_status',
  'max_parallel',
  'active',
  'available',
  'queued_orders',
  'dispatchable_orders',
  'freshness',
  'age_seconds',
  'stale_after_seconds',
] as const;

const EVIDENCE_KEYS = [
  'version',
  'runner_id',
  'observed_at',
  'manifest',
  'host_local_proven',
  'remote_capable_proven',
  'fingerprint',
] as const;

const MANIFEST_KEYS = [
  'version',
  'runner_id',
  'protocol_version',
  'runtime',
  'runtime_version',
  'platform',
  'location',
  'max_parallel',
  'capabilities',
  'adapters',
  'fingerprint',
] as const;

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} inválido.`);
  return value;
}

function parseResource(
  input: unknown,
  identity: RunnerIdentity,
  now: number,
): ParsedResource {
  const record = asRecord(input, 'ResourceSnapshot');
  exactKeys(record, RESOURCE_KEYS, 'ResourceSnapshot');
  if (record.version !== 1 || record.freshness !== 'fresh') {
    throw new TypeError('ResourceSnapshot no está fresco.');
  }

  const runnerId = uuid(record.runner_id, 'resource.runner_id');
  const observedAt = integer(record.observed_at, 'resource.observed_at');
  const ageSeconds = integer(record.age_seconds, 'resource.age_seconds');
  const staleAfterSeconds = integer(
    record.stale_after_seconds,
    'resource.stale_after_seconds',
    1,
    300,
  );
  const maxParallel = integer(record.max_parallel, 'resource.max_parallel', 1, 64);
  const active = integer(record.active, 'resource.active', 0, maxParallel);
  const available = integer(record.available, 'resource.available', 0, maxParallel);
  const queued = integer(record.queued_orders, 'resource.queued_orders');
  const dispatchable = integer(record.dispatchable_orders, 'resource.dispatchable_orders');
  integer(record.heartbeat_sequence, 'resource.heartbeat_sequence');

  if (runnerId !== identity.runner_id || maxParallel !== identity.max_parallel) {
    throw new TypeError('ResourceSnapshot pertenece a otro runner.');
  }
  if (observedAt > now || ageSeconds !== now - observedAt || ageSeconds > staleAfterSeconds) {
    throw new TypeError('ResourceSnapshot stale o temporalmente incoherente.');
  }
  if (active + available > maxParallel || dispatchable > Math.min(available, queued)) {
    throw new TypeError('ResourceSnapshot capacidad incoherente.');
  }

  return {
    runner_id: runnerId,
    observed_at: observedAt,
    fingerprint: stableSha256(record),
  };
}

function parseCapabilityEvidence(
  input: unknown,
  identity: RunnerIdentity,
  resource: ParsedResource,
): ParsedCapabilityEvidence {
  const record = asRecord(input, 'BrowserPlacementCapabilityEvidence');
  exactKeys(record, EVIDENCE_KEYS, 'BrowserPlacementCapabilityEvidence');
  if (record.version !== 1) throw new TypeError('Capability evidence version inválida.');

  const runnerId = uuid(record.runner_id, 'evidence.runner_id');
  const observedAt = integer(record.observed_at, 'evidence.observed_at');
  if (runnerId !== identity.runner_id || observedAt !== resource.observed_at) {
    throw new TypeError('Capability evidence mezclada o stale.');
  }

  const manifestRecord = asRecord(record.manifest, 'CapabilityManifest');
  exactKeys(manifestRecord, MANIFEST_KEYS, 'CapabilityManifest');
  if (!Array.isArray(manifestRecord.adapters)) {
    throw new TypeError('CapabilityManifest adapters inválidos.');
  }

  const adapters = manifestRecord.adapters.map((value, index) => {
    const adapter = asRecord(value, `manifest.adapters[${index}]`);
    exactKeys(adapter, ['adapter_id', 'capabilities'], `manifest.adapters[${index}]`);
    if (!Array.isArray(adapter.capabilities)) {
      throw new TypeError('CapabilityManifest capabilities inválidas.');
    }
    return { id: adapter.adapter_id as string, capabilities: adapter.capabilities as string[] };
  });
  const canonicalManifest = capabilityManifest(identity, adapters);
  if (stableSha256(manifestRecord) !== stableSha256(canonicalManifest)) {
    throw new TypeError('CapabilityManifest no es canónico.');
  }

  const core = {
    version: 1 as const,
    runner_id: runnerId,
    observed_at: observedAt,
    manifest: canonicalManifest,
    host_local_proven: bool(record.host_local_proven, 'host_local_proven'),
    remote_capable_proven: bool(record.remote_capable_proven, 'remote_capable_proven'),
  };
  const expectedFingerprint = stableSha256(core);
  if (record.fingerprint !== expectedFingerprint) {
    throw new TypeError('Capability evidence fingerprint incoherente.');
  }

  return {
    runner_id: runnerId,
    observed_at: observedAt,
    host_local_proven: core.host_local_proven,
    remote_capable_proven: core.remote_capable_proven,
    manifest_fingerprint: canonicalManifest.fingerprint,
    evidence_fingerprint: expectedFingerprint,
  };
}

export function browserPlacementProfile(
  identityInput: unknown,
  resourceInput: unknown,
  capabilityEvidenceInput: unknown,
  nowInput: unknown,
): BrowserPlacementProfile {
  const identity = parseRunnerIdentity(identityInput);
  const now = integer(nowInput, 'now');
  const resource = parseResource(resourceInput, identity, now);
  const evidence = parseCapabilityEvidence(capabilityEvidenceInput, identity, resource);

  const core: BrowserPlacementProfileCore = {
    version: 1,
    authority: 'unchanged',
    runner_id: identity.runner_id,
    observed_at: resource.observed_at,
    host_local_proven: evidence.host_local_proven,
    remote_capable_proven: evidence.remote_capable_proven,
    status: evidence.host_local_proven || evidence.remote_capable_proven ? 'KNOWN' : 'UNKNOWN',
    identity_fingerprint: stableSha256(identity),
    resource_fingerprint: resource.fingerprint,
    manifest_fingerprint: evidence.manifest_fingerprint,
    evidence_fingerprint: evidence.evidence_fingerprint,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
