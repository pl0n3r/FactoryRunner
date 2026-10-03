import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import {
  browserRemoteDirectorySnapshot,
  type BrowserRemoteDirectorySnapshot,
} from './browser-remote-directory-snapshot.ts';
import {
  browserRemoteDirectoryReadiness,
  type BrowserRemoteDirectoryReadiness,
} from './browser-remote-directory-readiness.ts';
import {
  asRecord,
  exactKeys,
  stableSha256,
} from './validation.ts';

export type BrowserRemoteDirectoryDoctor = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'DIRECTORY_READY' | 'DIRECTORY_UNAVAILABLE';
  runner_id: string | null;
  location: string | null;
  snapshot_fingerprint: string;
  readiness_fingerprint: string;
  evidence_current: boolean;
  fingerprint: string;
}>;

type BrowserRemoteDirectoryDoctorCore = Omit<
  BrowserRemoteDirectoryDoctor,
  'fingerprint'
>;

const SNAPSHOT_KEYS = [
  'version',
  'authority',
  'size',
  'profiles',
  'fingerprint',
] as const;

const READINESS_KEYS = [
  'version',
  'authority',
  'status',
  'runner_id',
  'location',
  'snapshot_fingerprint',
  'heartbeat_sequence',
  'heartbeat_observed_at',
  'heartbeat_health',
  'available_capacity',
  'capabilities',
  'fingerprint',
] as const;

function evidenceMatches(
  input: unknown,
  expected: object,
  keys: readonly string[],
  label: string,
): boolean {
  try {
    const record = asRecord(input, label);
    exactKeys(record, keys, label);
    return stableSha256(record) === stableSha256(expected);
  } catch {
    return false;
  }
}

function bundle(
  snapshot: BrowserRemoteDirectorySnapshot,
  readiness: BrowserRemoteDirectoryReadiness,
  evidenceCurrent: boolean,
): BrowserRemoteDirectoryDoctor {
  const ready = evidenceCurrent && readiness.status === 'ready';
  const core: BrowserRemoteDirectoryDoctorCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: ready ? 'DIRECTORY_READY' : 'DIRECTORY_UNAVAILABLE',
    runner_id: readiness.runner_id,
    location: readiness.location,
    snapshot_fingerprint: snapshot.fingerprint,
    readiness_fingerprint: readiness.fingerprint,
    evidence_current: evidenceCurrent,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

export function browserRemoteDirectoryDoctor(
  identityInput: unknown,
  heartbeatInput: unknown,
  directory: BrowserRemoteDirectory,
  snapshotEvidenceInput: unknown,
  readinessEvidenceInput: unknown,
  nowInput: unknown,
): BrowserRemoteDirectoryDoctor {
  if (!(directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  const currentSnapshot = browserRemoteDirectorySnapshot(directory);
  const currentReadiness = browserRemoteDirectoryReadiness(
    identityInput,
    heartbeatInput,
    currentSnapshot,
    nowInput,
  );

  const snapshotCurrent = evidenceMatches(
    snapshotEvidenceInput,
    currentSnapshot,
    SNAPSHOT_KEYS,
    'BrowserRemoteDirectorySnapshot',
  );
  const readinessCurrent = evidenceMatches(
    readinessEvidenceInput,
    currentReadiness,
    READINESS_KEYS,
    'BrowserRemoteDirectoryReadiness',
  );

  return bundle(
    currentSnapshot,
    currentReadiness,
    snapshotCurrent && readinessCurrent,
  );
}
