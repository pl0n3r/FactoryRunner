import type {
  BrowserRemoteDirectoryHealthBundle,
} from './browser-remote-directory-health-bundle.ts';
import {
  browserRemoteObservabilityManifest,
  type BrowserRemoteObservabilityManifest,
  type BrowserRemoteObservabilityManifestEntry,
} from './browser-remote-observability-manifest.ts';
import {
  asRecord,
  exactKeys,
  stableSha256,
  stringValue,
} from './validation.ts';

export type BrowserRemoteObservabilityConsumerPacket = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'READY' | 'UNAVAILABLE';
  exports: readonly BrowserRemoteObservabilityManifestEntry[];
  manifest_fingerprint: string;
  health_bundle_fingerprint: string;
  snapshot_fingerprint: string;
  readiness_fingerprint: string;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type PacketCore = Omit<BrowserRemoteObservabilityConsumerPacket, 'fingerprint'>;

const MANIFEST_KEYS = ['version', 'authority', 'exports', 'fingerprint'] as const;
const BUNDLE_KEYS = [
  'version',
  'authority',
  'status',
  'doctor_fingerprint',
  'health_fingerprint',
  'metrics_fingerprint',
  'snapshot_fingerprint',
  'readiness_fingerprint',
  'network_access',
  'external_mutation',
  'fingerprint',
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) {
    throw new TypeError(field + ' inválido.');
  }
  return parsed;
}

function canonicalManifest(input: unknown): BrowserRemoteObservabilityManifest {
  const record = asRecord(input, 'BrowserRemoteObservabilityManifest');
  exactKeys(record, MANIFEST_KEYS, 'BrowserRemoteObservabilityManifest');

  const expected = browserRemoteObservabilityManifest();
  if (stableSha256(record) !== stableSha256(expected)) {
    throw new TypeError('BrowserRemoteObservabilityManifest no es canónico.');
  }
  return expected;
}

function canonicalHealthBundle(input: unknown): BrowserRemoteDirectoryHealthBundle {
  const record = asRecord(input, 'BrowserRemoteDirectoryHealthBundle');
  exactKeys(record, BUNDLE_KEYS, 'BrowserRemoteDirectoryHealthBundle');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || (record.status !== 'READY' && record.status !== 'UNAVAILABLE')
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('BrowserRemoteDirectoryHealthBundle inválido.');
  }

  const doctorFingerprint = sha256(
    record.doctor_fingerprint,
    'bundle.doctor_fingerprint',
  );
  const healthFingerprint = sha256(
    record.health_fingerprint,
    'bundle.health_fingerprint',
  );
  const metricsFingerprint = sha256(
    record.metrics_fingerprint,
    'bundle.metrics_fingerprint',
  );
  const snapshotFingerprint = sha256(
    record.snapshot_fingerprint,
    'bundle.snapshot_fingerprint',
  );
  const readinessFingerprint = sha256(
    record.readiness_fingerprint,
    'bundle.readiness_fingerprint',
  );
  const fingerprint = sha256(record.fingerprint, 'bundle.fingerprint');

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: record.status,
    doctor_fingerprint: doctorFingerprint,
    health_fingerprint: healthFingerprint,
    metrics_fingerprint: metricsFingerprint,
    snapshot_fingerprint: snapshotFingerprint,
    readiness_fingerprint: readinessFingerprint,
    network_access: false as const,
    external_mutation: false as const,
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserRemoteDirectoryHealthBundle fingerprint incoherente.');
  }

  return Object.freeze({
    ...core,
    fingerprint,
  });
}

export function browserRemoteObservabilityConsumerPacket(
  manifestInput: unknown,
  healthBundleInput: unknown,
): BrowserRemoteObservabilityConsumerPacket {
  const manifest = canonicalManifest(manifestInput);
  const bundle = canonicalHealthBundle(healthBundleInput);
  const exports = Object.freeze(
    manifest.exports.map((entry) => Object.freeze({ ...entry })),
  );

  const core: PacketCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: bundle.status,
    exports,
    manifest_fingerprint: manifest.fingerprint,
    health_bundle_fingerprint: bundle.fingerprint,
    snapshot_fingerprint: bundle.snapshot_fingerprint,
    readiness_fingerprint: bundle.readiness_fingerprint,
    network_access: false,
    external_mutation: false,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
