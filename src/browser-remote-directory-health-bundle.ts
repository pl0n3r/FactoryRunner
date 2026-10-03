import type { BrowserRemoteDirectoryDoctor } from './browser-remote-directory-doctor.ts';
import type { BrowserRemoteDirectoryHealth } from './browser-remote-directory-health.ts';
import {
  browserRemoteDirectoryMetrics,
  type BrowserRemoteDirectoryMetrics,
} from './browser-remote-directory-metrics.ts';
import {
  asRecord,
  exactKeys,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserRemoteDirectoryHealthBundle = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'READY' | 'UNAVAILABLE';
  doctor_fingerprint: string;
  health_fingerprint: string;
  metrics_fingerprint: string;
  snapshot_fingerprint: string;
  readiness_fingerprint: string;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type BundleCore = Omit<BrowserRemoteDirectoryHealthBundle, 'fingerprint'>;

type DoctorEvidence = Readonly<{
  status: BrowserRemoteDirectoryDoctor['status'];
  evidence_current: boolean;
  snapshot_fingerprint: string;
  readiness_fingerprint: string;
  fingerprint: string;
}>;

type HealthEvidence = Readonly<{
  status: BrowserRemoteDirectoryHealth['status'];
  diagnostics_pass: number;
  diagnostics_blocked: number;
  doctor_fingerprint: string | null;
  snapshot_fingerprint: string;
  fingerprint: string;
  metrics: BrowserRemoteDirectoryMetrics;
}>;

const DOCTOR_KEYS = [
  'version',
  'authority',
  'status',
  'runner_id',
  'location',
  'snapshot_fingerprint',
  'readiness_fingerprint',
  'evidence_current',
  'fingerprint',
] as const;

const HEALTH_KEYS = [
  'version',
  'authority',
  'status',
  'profiles_total',
  'capabilities_total',
  'diagnostics_pass',
  'diagnostics_blocked',
  'doctor_fingerprint',
  'snapshot_fingerprint',
  'fingerprint',
] as const;

const METRICS_KEYS = [
  'version',
  'authority',
  'readiness',
  'profiles_total',
  'capabilities_total',
  'diagnostics_pass',
  'diagnostics_blocked',
  'fingerprint',
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_CHECKS = 4;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
  return parsed;
}

function canonicalDoctor(input: unknown): DoctorEvidence {
  const record = asRecord(input, 'BrowserRemoteDirectoryDoctor');
  exactKeys(record, DOCTOR_KEYS, 'BrowserRemoteDirectoryDoctor');

  if (record.version !== 1 || record.authority !== 'unchanged') {
    throw new TypeError('BrowserRemoteDirectoryDoctor inválido.');
  }
  if (
    record.status !== 'DIRECTORY_READY'
    && record.status !== 'DIRECTORY_UNAVAILABLE'
  ) {
    throw new TypeError('BrowserRemoteDirectoryDoctor status inválido.');
  }
  if (typeof record.evidence_current !== 'boolean') {
    throw new TypeError('BrowserRemoteDirectoryDoctor evidence_current inválido.');
  }

  const runnerId = record.runner_id === null
    ? null
    : uuid(record.runner_id, 'doctor.runner_id');
  const location = record.location === null
    ? null
    : stringValue(record.location, 'doctor.location', 128);
  const snapshotFingerprint = sha256(
    record.snapshot_fingerprint,
    'doctor.snapshot_fingerprint',
  );
  const readinessFingerprint = sha256(
    record.readiness_fingerprint,
    'doctor.readiness_fingerprint',
  );
  const fingerprint = sha256(record.fingerprint, 'doctor.fingerprint');

  if (
    record.status === 'DIRECTORY_READY'
    && (
      record.evidence_current !== true
      || runnerId === null
      || location === null
    )
  ) {
    throw new TypeError('BrowserRemoteDirectoryDoctor READY contradictorio.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: record.status,
    runner_id: runnerId,
    location,
    snapshot_fingerprint: snapshotFingerprint,
    readiness_fingerprint: readinessFingerprint,
    evidence_current: record.evidence_current,
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserRemoteDirectoryDoctor fingerprint incoherente.');
  }

  return Object.freeze({
    status: record.status,
    evidence_current: record.evidence_current,
    snapshot_fingerprint: snapshotFingerprint,
    readiness_fingerprint: readinessFingerprint,
    fingerprint,
  });
}

function canonicalHealth(input: unknown): HealthEvidence {
  const metrics = browserRemoteDirectoryMetrics(input);
  const record = asRecord(input, 'BrowserRemoteDirectoryHealth');
  exactKeys(record, HEALTH_KEYS, 'BrowserRemoteDirectoryHealth');

  return Object.freeze({
    status: record.status as BrowserRemoteDirectoryHealth['status'],
    diagnostics_pass: record.diagnostics_pass as number,
    diagnostics_blocked: record.diagnostics_blocked as number,
    doctor_fingerprint: record.doctor_fingerprint === null
      ? null
      : sha256(record.doctor_fingerprint, 'health.doctor_fingerprint'),
    snapshot_fingerprint: sha256(
      record.snapshot_fingerprint,
      'health.snapshot_fingerprint',
    ),
    fingerprint: sha256(record.fingerprint, 'health.fingerprint'),
    metrics,
  });
}

function requireMetrics(
  input: unknown,
  expected: BrowserRemoteDirectoryMetrics,
): BrowserRemoteDirectoryMetrics {
  const record = asRecord(input, 'BrowserRemoteDirectoryMetrics');
  exactKeys(record, METRICS_KEYS, 'BrowserRemoteDirectoryMetrics');
  if (stableSha256(record) !== stableSha256(expected)) {
    throw new TypeError('BrowserRemoteDirectoryMetrics no pertenece al health.');
  }
  return expected;
}

export function browserRemoteDirectoryHealthBundle(
  doctorInput: unknown,
  healthInput: unknown,
  metricsInput: unknown,
): BrowserRemoteDirectoryHealthBundle {
  const doctor = canonicalDoctor(doctorInput);
  const health = canonicalHealth(healthInput);
  const metrics = requireMetrics(metricsInput, health.metrics);

  if (
    health.doctor_fingerprint !== doctor.fingerprint
    || health.snapshot_fingerprint !== doctor.snapshot_fingerprint
  ) {
    throw new TypeError('Evidencia doctor/health mezclada o stale.');
  }

  const expectedDiagnostics =
    2
    + (doctor.evidence_current ? 1 : 0)
    + (doctor.status === 'DIRECTORY_READY' ? 1 : 0);
  const expectedBlocked = DIAGNOSTIC_CHECKS - expectedDiagnostics;
  const expectedHealthStatus = expectedBlocked === 0 ? 'READY' : 'UNAVAILABLE';

  if (
    health.diagnostics_pass !== expectedDiagnostics
    || health.diagnostics_blocked !== expectedBlocked
    || health.status !== expectedHealthStatus
    || metrics.readiness !== (expectedHealthStatus === 'READY' ? 1 : 0)
  ) {
    throw new TypeError('Evidencia doctor/health/metrics incoherente.');
  }

  const core: BundleCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: expectedHealthStatus,
    doctor_fingerprint: doctor.fingerprint,
    health_fingerprint: health.fingerprint,
    metrics_fingerprint: metrics.fingerprint,
    snapshot_fingerprint: doctor.snapshot_fingerprint,
    readiness_fingerprint: doctor.readiness_fingerprint,
    network_access: false,
    external_mutation: false,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
