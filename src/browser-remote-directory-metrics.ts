import type { BrowserRemoteDirectoryHealth } from './browser-remote-directory-health.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  stringValue,
} from './validation.ts';

export type BrowserRemoteDirectoryMetrics = Readonly<{
  version: 1;
  authority: 'unchanged';
  readiness: 0 | 1;
  profiles_total: number;
  capabilities_total: number;
  diagnostics_pass: number;
  diagnostics_blocked: number;
  fingerprint: string;
}>;

type BrowserRemoteDirectoryMetricsCore = Omit<
  BrowserRemoteDirectoryMetrics,
  'fingerprint'
>;

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

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PROFILES = 10_000;
const MAX_CAPABILITIES = 1_000;
const DIAGNOSTIC_CHECKS = 4;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) {
    throw new TypeError(field + ' inválido.');
  }
  return parsed;
}

function canonicalHealth(input: unknown): BrowserRemoteDirectoryHealth {
  const record = asRecord(input, 'BrowserRemoteDirectoryHealth');
  exactKeys(record, HEALTH_KEYS, 'BrowserRemoteDirectoryHealth');

  if (record.version !== 1 || record.authority !== 'unchanged') {
    throw new TypeError('BrowserRemoteDirectoryHealth inválido.');
  }
  if (record.status !== 'READY' && record.status !== 'UNAVAILABLE') {
    throw new TypeError('BrowserRemoteDirectoryHealth status inválido.');
  }

  const profilesTotal = integer(
    record.profiles_total,
    'health.profiles_total',
    0,
    MAX_PROFILES,
  );
  const capabilitiesTotal = integer(
    record.capabilities_total,
    'health.capabilities_total',
    0,
    MAX_CAPABILITIES,
  );
  const diagnosticsPass = integer(
    record.diagnostics_pass,
    'health.diagnostics_pass',
    0,
    DIAGNOSTIC_CHECKS,
  );
  const diagnosticsBlocked = integer(
    record.diagnostics_blocked,
    'health.diagnostics_blocked',
    0,
    DIAGNOSTIC_CHECKS,
  );
  if (diagnosticsPass + diagnosticsBlocked !== DIAGNOSTIC_CHECKS) {
    throw new TypeError('BrowserRemoteDirectoryHealth diagnósticos incoherentes.');
  }
  if (
    (record.status === 'READY' && diagnosticsBlocked !== 0)
    || (record.status === 'UNAVAILABLE' && diagnosticsBlocked === 0)
  ) {
    throw new TypeError('BrowserRemoteDirectoryHealth status contradictorio.');
  }

  const doctorFingerprint = record.doctor_fingerprint === null
    ? null
    : sha256(record.doctor_fingerprint, 'health.doctor_fingerprint');
  const snapshotFingerprint = sha256(
    record.snapshot_fingerprint,
    'health.snapshot_fingerprint',
  );
  const fingerprint = sha256(record.fingerprint, 'health.fingerprint');

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: record.status,
    profiles_total: profilesTotal,
    capabilities_total: capabilitiesTotal,
    diagnostics_pass: diagnosticsPass,
    diagnostics_blocked: diagnosticsBlocked,
    doctor_fingerprint: doctorFingerprint,
    snapshot_fingerprint: snapshotFingerprint,
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserRemoteDirectoryHealth fingerprint incoherente.');
  }

  return Object.freeze({
    ...core,
    fingerprint,
  });
}

export function browserRemoteDirectoryMetrics(
  healthInput: unknown,
): BrowserRemoteDirectoryMetrics {
  const health = canonicalHealth(healthInput);
  const core: BrowserRemoteDirectoryMetricsCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    readiness: health.status === 'READY' ? 1 : 0,
    profiles_total: health.profiles_total,
    capabilities_total: health.capabilities_total,
    diagnostics_pass: health.diagnostics_pass,
    diagnostics_blocked: health.diagnostics_blocked,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
