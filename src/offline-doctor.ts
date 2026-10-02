import type { ReadinessSnapshot } from './readiness-snapshot.ts';
import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

type DiagnosticStatus = 'PASS' | 'BLOCKED';
type RuntimeStatus = ReadinessSnapshot['runtime_status'];

export type OfflineDoctorDiagnostic = {
  code: 'snapshot-contract' | 'readiness-state' | 'runtime-state' | 'evidence-chain';
  status: DiagnosticStatus;
};

export type OfflineDoctorReport = {
  version: 1;
  status: DiagnosticStatus;
  authority: 'unchanged';
  source: {
    runner_id: string | null;
    observed_at: number | null;
    readiness_status: 'READY' | 'BLOCKED' | 'UNKNOWN';
    runtime_status: RuntimeStatus;
    fingerprint: string | null;
  };
  diagnostics: OfflineDoctorDiagnostic[];
  network_access: false;
  provider_access: false;
  external_mutation: false;
  fingerprint: string;
};

type ParsedSnapshot = ReadinessSnapshot;
type ReportCore = Omit<OfflineDoctorReport, 'fingerprint'>;

const SNAPSHOT_KEYS = [
  'version',
  'status',
  'ready',
  'authority',
  'runner_id',
  'observed_at',
  'runtime_status',
  'protocol_fingerprint',
  'manifest_fingerprint',
  'resource_fingerprint',
  'telemetry_fingerprint',
  'reasons',
  'fingerprint',
] as const;

const RUNTIME_STATUSES = new Set<RuntimeStatus>([
  'ready',
  'busy',
  'draining',
  'offline',
  'unknown',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256OrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(`${field} inválido.`);
  return parsed;
}

function parseSnapshot(input: unknown): ParsedSnapshot {
  const record = asRecord(input, 'ReadinessSnapshot');
  exactKeys(record, SNAPSHOT_KEYS, 'ReadinessSnapshot');

  if (record.version !== 1) throw new TypeError('ReadinessSnapshot version inválida.');
  if (record.status !== 'READY' && record.status !== 'BLOCKED') {
    throw new TypeError('ReadinessSnapshot status inválido.');
  }
  if (typeof record.ready !== 'boolean' || record.ready !== (record.status === 'READY')) {
    throw new TypeError('ReadinessSnapshot ready inconsistente.');
  }
  if (record.authority !== 'unchanged') throw new TypeError('ReadinessSnapshot authority inválida.');
  if (typeof record.runtime_status !== 'string' || !RUNTIME_STATUSES.has(record.runtime_status as RuntimeStatus)) {
    throw new TypeError('ReadinessSnapshot runtime_status inválido.');
  }

  const runnerId = record.runner_id === null ? null : uuid(record.runner_id, 'snapshot.runner_id');
  const observedAt = record.observed_at === null
    ? null
    : integer(record.observed_at, 'snapshot.observed_at');

  if (!Array.isArray(record.reasons) || record.reasons.length === 0 || record.reasons.length > 32) {
    throw new TypeError('ReadinessSnapshot reasons inválidas.');
  }
  const reasons = record.reasons.map((reason, index) =>
    noSensitiveText(stringValue(reason, `snapshot.reasons[${index}]`, 120), `snapshot.reasons[${index}]`),
  );

  const snapshot: ParsedSnapshot = {
    version: 1,
    status: record.status,
    ready: record.ready,
    authority: 'unchanged',
    runner_id: runnerId,
    observed_at: observedAt,
    runtime_status: record.runtime_status as RuntimeStatus,
    protocol_fingerprint: sha256OrNull(record.protocol_fingerprint, 'snapshot.protocol_fingerprint'),
    manifest_fingerprint: sha256OrNull(record.manifest_fingerprint, 'snapshot.manifest_fingerprint'),
    resource_fingerprint: sha256OrNull(record.resource_fingerprint, 'snapshot.resource_fingerprint'),
    telemetry_fingerprint: sha256OrNull(record.telemetry_fingerprint, 'snapshot.telemetry_fingerprint'),
    reasons,
    fingerprint: sha256OrNull(record.fingerprint, 'snapshot.fingerprint') ?? '',
  };

  const { fingerprint, ...core } = snapshot;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ReadinessSnapshot fingerprint incoherente.');
  }

  if (snapshot.status === 'READY') {
    const identityObserved = snapshot.runner_id !== null && snapshot.observed_at !== null;
    const runtimeDispatchable = snapshot.runtime_status === 'ready' || snapshot.runtime_status === 'busy';
    const evidenceComplete = [
      snapshot.protocol_fingerprint,
      snapshot.manifest_fingerprint,
      snapshot.resource_fingerprint,
      snapshot.telemetry_fingerprint,
    ].every((value) => value !== null);
    const reasonsCoherent =
      snapshot.reasons.length === 1
      && snapshot.reasons[0] === 'readiness_evidence_coherent';

    if (!identityObserved || !runtimeDispatchable || !evidenceComplete || !reasonsCoherent) {
      throw new TypeError('ReadinessSnapshot READY contradictorio.');
    }
  }

  return snapshot;
}

function report(core: ReportCore): OfflineDoctorReport {
  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

function invalidReport(): OfflineDoctorReport {
  return report({
    version: 1,
    status: 'BLOCKED',
    authority: 'unchanged',
    source: {
      runner_id: null,
      observed_at: null,
      readiness_status: 'UNKNOWN',
      runtime_status: 'unknown',
      fingerprint: null,
    },
    diagnostics: [
      { code: 'snapshot-contract', status: 'BLOCKED' },
      { code: 'readiness-state', status: 'BLOCKED' },
      { code: 'runtime-state', status: 'BLOCKED' },
      { code: 'evidence-chain', status: 'BLOCKED' },
    ],
    network_access: false,
    provider_access: false,
    external_mutation: false,
  });
}

export function offlineDoctor(snapshotInput: unknown): OfflineDoctorReport {
  let snapshot: ParsedSnapshot;
  try {
    snapshot = parseSnapshot(snapshotInput);
  } catch {
    return invalidReport();
  }

  const runtimePass = snapshot.runtime_status === 'ready' || snapshot.runtime_status === 'busy';
  const evidencePass = [
    snapshot.protocol_fingerprint,
    snapshot.manifest_fingerprint,
    snapshot.resource_fingerprint,
    snapshot.telemetry_fingerprint,
  ].every((value) => value !== null);
  const readinessPass = snapshot.status === 'READY' && snapshot.ready;
  const diagnostics: OfflineDoctorDiagnostic[] = [
    { code: 'snapshot-contract', status: 'PASS' },
    { code: 'readiness-state', status: readinessPass ? 'PASS' : 'BLOCKED' },
    { code: 'runtime-state', status: runtimePass ? 'PASS' : 'BLOCKED' },
    { code: 'evidence-chain', status: evidencePass ? 'PASS' : 'BLOCKED' },
  ];
  const status: DiagnosticStatus = diagnostics.every((item) => item.status === 'PASS')
    ? 'PASS'
    : 'BLOCKED';

  return report({
    version: 1,
    status,
    authority: 'unchanged',
    source: {
      runner_id: snapshot.runner_id,
      observed_at: snapshot.observed_at,
      readiness_status: snapshot.status,
      runtime_status: snapshot.runtime_status,
      fingerprint: snapshot.fingerprint,
    },
    diagnostics,
    network_access: false,
    provider_access: false,
    external_mutation: false,
  });
}
