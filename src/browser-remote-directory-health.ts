import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import {
  browserRemoteDirectorySnapshot,
  type BrowserRemoteDirectorySnapshot,
} from './browser-remote-directory-snapshot.ts';
import type { BrowserRemoteDirectoryDoctor } from './browser-remote-directory-doctor.ts';
import {
  asRecord,
  exactKeys,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserRemoteDirectoryHealth = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'READY' | 'UNAVAILABLE';
  profiles_total: number;
  capabilities_total: number;
  diagnostics_pass: number;
  diagnostics_blocked: number;
  doctor_fingerprint: string | null;
  snapshot_fingerprint: string;
  fingerprint: string;
}>;

type BrowserRemoteDirectoryHealthCore = Omit<
  BrowserRemoteDirectoryHealth,
  'fingerprint'
>;

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

const SHA256_RE = /^[0-9a-f]{64}$/;
const DIAGNOSTIC_CHECKS = 4;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) {
    throw new TypeError(field + ' inválido.');
  }
  return parsed;
}

function canonicalDoctor(input: unknown): BrowserRemoteDirectoryDoctor {
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
    ...core,
    fingerprint,
  });
}

function aggregate(snapshot: BrowserRemoteDirectorySnapshot): {
  profilesTotal: number;
  capabilitiesTotal: number;
} {
  return {
    profilesTotal: snapshot.size,
    capabilitiesTotal: new Set(
      snapshot.profiles.map((profile) => profile.capability),
    ).size,
  };
}

function health(
  snapshot: BrowserRemoteDirectorySnapshot,
  doctor: BrowserRemoteDirectoryDoctor | null,
): BrowserRemoteDirectoryHealth {
  const counts = aggregate(snapshot);
  let diagnosticsPass = 0;

  if (doctor !== null) {
    diagnosticsPass += 1;
    if (doctor.evidence_current) diagnosticsPass += 1;
    if (doctor.status === 'DIRECTORY_READY') diagnosticsPass += 1;
    if (doctor.snapshot_fingerprint === snapshot.fingerprint) {
      diagnosticsPass += 1;
    }
  }

  const diagnosticsBlocked = DIAGNOSTIC_CHECKS - diagnosticsPass;
  const core: BrowserRemoteDirectoryHealthCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: diagnosticsBlocked === 0 ? 'READY' : 'UNAVAILABLE',
    profiles_total: counts.profilesTotal,
    capabilities_total: counts.capabilitiesTotal,
    diagnostics_pass: diagnosticsPass,
    diagnostics_blocked: diagnosticsBlocked,
    doctor_fingerprint: doctor?.fingerprint ?? null,
    snapshot_fingerprint: snapshot.fingerprint,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

export function browserRemoteDirectoryHealth(
  directory: BrowserRemoteDirectory,
  doctorEvidenceInput: unknown,
): BrowserRemoteDirectoryHealth {
  if (!(directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  const snapshot = browserRemoteDirectorySnapshot(directory);
  let doctor: BrowserRemoteDirectoryDoctor | null = null;
  try {
    doctor = canonicalDoctor(doctorEvidenceInput);
  } catch {
    return health(snapshot, null);
  }

  return health(snapshot, doctor);
}
