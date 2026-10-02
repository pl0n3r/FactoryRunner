import { capabilityManifest, type CapabilityAdapterSource } from './capability-manifest.ts';
import { protocolCompatibility } from './protocol-compatibility.ts';
import { resourceSnapshot } from './resource-snapshot.ts';
import { parseRunnerIdentity } from './runner.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

type RuntimeStatus = 'ready' | 'busy' | 'draining' | 'offline' | 'unknown';
type Freshness = 'fresh' | 'stale' | 'unknown';

export type ReadinessRuntimeState = {
  version: 1;
  runner_id: string;
  observed_at: number;
  status: RuntimeStatus;
  freshness: Freshness;
  authority: 'unchanged';
};

type TelemetryEvidence = {
  version: 1;
  runner_id: string;
  order_id: string;
  work_item_id: string;
  capability: string;
  observed_at: number;
  instruction_ref: string;
  manifest_fingerprint: string;
  order_fingerprint: string;
  resource_fingerprint: string;
  metrics: Record<string, unknown>;
  authority: 'unchanged';
  execute_actions: false;
  fingerprint: string;
};

export type ReadinessSnapshot = {
  version: 1;
  status: 'READY' | 'BLOCKED';
  ready: boolean;
  authority: 'unchanged';
  runner_id: string | null;
  observed_at: number | null;
  runtime_status: RuntimeStatus;
  protocol_fingerprint: string | null;
  manifest_fingerprint: string | null;
  resource_fingerprint: string | null;
  telemetry_fingerprint: string | null;
  reasons: string[];
  fingerprint: string;
};

type SnapshotCore = Omit<ReadinessSnapshot, 'fingerprint'>;
type EvidenceRefs = Pick<
  SnapshotCore,
  | 'observed_at'
  | 'runtime_status'
  | 'protocol_fingerprint'
  | 'manifest_fingerprint'
  | 'resource_fingerprint'
  | 'telemetry_fingerprint'
>;

const TELEMETRY_KEYS = [
  'version',
  'runner_id',
  'order_id',
  'work_item_id',
  'capability',
  'observed_at',
  'instruction_ref',
  'manifest_fingerprint',
  'order_fingerprint',
  'resource_fingerprint',
  'metrics',
  'authority',
  'execute_actions',
  'fingerprint',
] as const;
const RUNTIME_KEYS = [
  'version',
  'runner_id',
  'observed_at',
  'status',
  'freshness',
  'authority',
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RUNTIME_STATUSES = new Set<RuntimeStatus>([
  'ready',
  'busy',
  'draining',
  'offline',
  'unknown',
]);
const FRESHNESS = new Set<Freshness>(['fresh', 'stale', 'unknown']);

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(`${field} inválido.`);
  return parsed;
}

function verdict(
  status: 'READY' | 'BLOCKED',
  runnerId: string | null,
  reasonsInput: readonly string[],
  evidence: EvidenceRefs,
): ReadinessSnapshot {
  const reasons = [...new Set(reasonsInput)].sort((a, b) => a.localeCompare(b, 'en'));
  const core: SnapshotCore = {
    version: 1,
    status,
    ready: status === 'READY',
    authority: 'unchanged',
    runner_id: runnerId,
    ...evidence,
    reasons,
  };
  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

function emptyEvidence(): EvidenceRefs {
  return {
    observed_at: null,
    runtime_status: 'unknown',
    protocol_fingerprint: null,
    manifest_fingerprint: null,
    resource_fingerprint: null,
    telemetry_fingerprint: null,
  };
}

function parseRuntimeState(input: unknown): ReadinessRuntimeState {
  const record = asRecord(input, 'ReadinessRuntimeState');
  exactKeys(record, RUNTIME_KEYS, 'ReadinessRuntimeState');
  if (record.version !== 1) throw new TypeError('Runtime state version inválida.');
  if (typeof record.status !== 'string' || !RUNTIME_STATUSES.has(record.status as RuntimeStatus)) {
    throw new TypeError('Runtime state status inválido.');
  }
  if (typeof record.freshness !== 'string' || !FRESHNESS.has(record.freshness as Freshness)) {
    throw new TypeError('Runtime state freshness inválida.');
  }
  if (record.authority !== 'unchanged') throw new TypeError('Runtime state authority inválida.');
  return {
    version: 1,
    runner_id: uuid(record.runner_id, 'runtime.runner_id'),
    observed_at: integer(record.observed_at, 'runtime.observed_at'),
    status: record.status as RuntimeStatus,
    freshness: record.freshness as Freshness,
    authority: 'unchanged',
  };
}

function parseTelemetry(input: unknown): TelemetryEvidence {
  const record = asRecord(input, 'TelemetryEnvelope');
  exactKeys(record, TELEMETRY_KEYS, 'TelemetryEnvelope');
  if (record.version !== 1) throw new TypeError('Telemetry version inválida.');
  if (record.authority !== 'unchanged' || record.execute_actions !== false) {
    throw new TypeError('Telemetry authority inválida.');
  }

  const metrics = asRecord(record.metrics, 'telemetry.metrics');
  const evidence: TelemetryEvidence = {
    version: 1,
    runner_id: uuid(record.runner_id, 'telemetry.runner_id'),
    order_id: stringValue(record.order_id, 'telemetry.order_id', 256),
    work_item_id: stringValue(record.work_item_id, 'telemetry.work_item_id', 256),
    capability: stringValue(record.capability, 'telemetry.capability', 128),
    observed_at: integer(record.observed_at, 'telemetry.observed_at'),
    instruction_ref: stringValue(record.instruction_ref, 'telemetry.instruction_ref', 256),
    manifest_fingerprint: sha256(record.manifest_fingerprint, 'telemetry.manifest_fingerprint'),
    order_fingerprint: sha256(record.order_fingerprint, 'telemetry.order_fingerprint'),
    resource_fingerprint: sha256(record.resource_fingerprint, 'telemetry.resource_fingerprint'),
    metrics,
    authority: 'unchanged',
    execute_actions: false,
    fingerprint: sha256(record.fingerprint, 'telemetry.fingerprint'),
  };

  const { fingerprint, ...core } = evidence;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('Telemetry fingerprint incoherente.');
  }
  return evidence;
}

export function readinessSnapshot(
  identityInput: unknown,
  adaptersInput: readonly CapabilityAdapterSource[],
  protocolContractInput: unknown,
  heartbeatInput: unknown,
  queueInput: unknown,
  telemetryInput: unknown,
  runtimeStateInput: unknown,
  nowInput: unknown,
  staleAfterSecondsInput: unknown,
): ReadinessSnapshot {
  let runnerId: string | null = null;
  let evidence = emptyEvidence();

  try {
    const identity = parseRunnerIdentity(identityInput);
    runnerId = identity.runner_id;
    const manifest = capabilityManifest(identity, adaptersInput);
    const protocol = protocolCompatibility(identity, protocolContractInput);
    evidence = {
      ...evidence,
      protocol_fingerprint: protocol.fingerprint,
      manifest_fingerprint: manifest.fingerprint,
    };

    if (protocol.status !== 'READY') {
      return verdict(
        'BLOCKED',
        runnerId,
        protocol.reasons.map((reason) => `protocol:${reason}`),
        evidence,
      );
    }

    const now = integer(nowInput, 'now');
    const staleAfterSeconds = integer(staleAfterSecondsInput, 'stale_after_seconds', 1, 300);
    const resources = resourceSnapshot(
      identity,
      heartbeatInput,
      queueInput,
      now,
      staleAfterSeconds,
    );
    const resourceFingerprint = stableSha256(resources);
    const telemetry = parseTelemetry(telemetryInput);
    const runtime = parseRuntimeState(runtimeStateInput);
    evidence = {
      observed_at: resources.observed_at,
      runtime_status: runtime.status,
      protocol_fingerprint: protocol.fingerprint,
      manifest_fingerprint: manifest.fingerprint,
      resource_fingerprint: resourceFingerprint,
      telemetry_fingerprint: telemetry.fingerprint,
    };

    const reasons: string[] = [];
    if (telemetry.runner_id !== identity.runner_id) reasons.push('telemetry_runner_mismatch');
    if (telemetry.manifest_fingerprint !== manifest.fingerprint) {
      reasons.push('telemetry_manifest_mismatch');
    }
    if (telemetry.resource_fingerprint !== resourceFingerprint) {
      reasons.push('telemetry_resource_mismatch');
    }
    if (telemetry.observed_at !== resources.observed_at) {
      reasons.push('telemetry_observation_mismatch');
    }
    if (runtime.runner_id !== identity.runner_id) reasons.push('runtime_runner_mismatch');
    if (runtime.observed_at !== resources.observed_at) reasons.push('runtime_observation_mismatch');
    if (runtime.freshness !== 'fresh') reasons.push('runtime_not_fresh');
    if (runtime.status !== resources.runner_status) reasons.push('runtime_status_mismatch');
    if (runtime.status === 'draining' || runtime.status === 'offline' || runtime.status === 'unknown') {
      reasons.push('runtime_not_dispatchable');
    }
    if (resources.available <= 0) reasons.push('capacity_unavailable');

    if (reasons.length > 0) return verdict('BLOCKED', runnerId, reasons, evidence);
    return verdict('READY', runnerId, ['readiness_evidence_coherent'], evidence);
  } catch {
    return verdict('BLOCKED', runnerId, ['readiness_evidence_invalid'], evidence);
  }
}
