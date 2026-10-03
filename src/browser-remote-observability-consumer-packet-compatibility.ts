import {
  browserRemoteObservabilityCompatibility,
  type BrowserRemoteObservabilityCompatibility,
} from './browser-remote-observability-compatibility.ts';
import type { BrowserRemoteObservabilityConsumerPacket } from './browser-remote-observability-consumer-packet.ts';
import {
  browserRemoteObservabilityManifest,
  type BrowserRemoteObservabilityManifest,
  type BrowserRemoteObservabilityManifestEntry,
} from './browser-remote-observability-manifest.ts';
import { asRecord, exactKeys, stableSha256, stringValue } from './validation.ts';

export type BrowserRemoteObservabilityConsumerPacketCompatibilityReason =
  | 'COMPATIBILITY_INVALID'
  | 'CONSUMER_INCOMPATIBLE'
  | 'MANIFEST_INVALID'
  | 'PACKET_INVALID'
  | 'PROVENANCE_MISMATCH';

export type BrowserRemoteObservabilityConsumerPacketCompatibility = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: readonly BrowserRemoteObservabilityConsumerPacketCompatibilityReason[];
  packet_fingerprint: string | null;
  manifest_fingerprint: string | null;
  compatibility_fingerprint: string | null;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type ResultCore = Omit<BrowserRemoteObservabilityConsumerPacketCompatibility, 'fingerprint'>;

const PACKET_KEYS = [
  'version', 'authority', 'status', 'exports', 'manifest_fingerprint',
  'health_bundle_fingerprint', 'snapshot_fingerprint', 'readiness_fingerprint',
  'network_access', 'external_mutation', 'fingerprint',
] as const;
const MANIFEST_KEYS = ['version', 'authority', 'exports', 'fingerprint'] as const;
const COMPATIBILITY_KEYS = [
  'version', 'authority', 'status', 'reasons', 'manifest_fingerprint',
  'network_access', 'external_mutation', 'fingerprint',
] as const;
const EXPORT_KEYS = ['export_name', 'contract_version'] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
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

function canonicalExports(input: unknown): readonly BrowserRemoteObservabilityManifestEntry[] {
  if (!Array.isArray(input)) throw new TypeError('packet.exports inválidos.');
  const expected = browserRemoteObservabilityManifest().exports;
  const parsed = input.map((value, index) => {
    const record = asRecord(value, `packet.exports[${index}]`);
    exactKeys(record, EXPORT_KEYS, `packet.exports[${index}]`);
    return Object.freeze({
      export_name: stringValue(record.export_name, `packet.exports[${index}].export_name`, 80),
      contract_version: record.contract_version,
    });
  });
  if (stableSha256(parsed) !== stableSha256(expected)) {
    throw new TypeError('packet.exports no coincide con el manifest canónico.');
  }
  return expected;
}

function canonicalPacket(input: unknown): BrowserRemoteObservabilityConsumerPacket {
  const record = asRecord(input, 'BrowserRemoteObservabilityConsumerPacket');
  exactKeys(record, PACKET_KEYS, 'BrowserRemoteObservabilityConsumerPacket');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || (record.status !== 'READY' && record.status !== 'UNAVAILABLE')
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('BrowserRemoteObservabilityConsumerPacket inválido.');
  }
  const exports = canonicalExports(record.exports);
  const manifestFingerprint = sha256(record.manifest_fingerprint, 'packet.manifest_fingerprint');
  const healthBundleFingerprint = sha256(record.health_bundle_fingerprint, 'packet.health_bundle_fingerprint');
  const snapshotFingerprint = sha256(record.snapshot_fingerprint, 'packet.snapshot_fingerprint');
  const readinessFingerprint = sha256(record.readiness_fingerprint, 'packet.readiness_fingerprint');
  const fingerprint = sha256(record.fingerprint, 'packet.fingerprint');
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: record.status,
    exports,
    manifest_fingerprint: manifestFingerprint,
    health_bundle_fingerprint: healthBundleFingerprint,
    snapshot_fingerprint: snapshotFingerprint,
    readiness_fingerprint: readinessFingerprint,
    network_access: false as const,
    external_mutation: false as const,
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserRemoteObservabilityConsumerPacket fingerprint incoherente.');
  }
  return Object.freeze({ ...core, fingerprint });
}

function canonicalCompatibility(
  input: unknown,
  expected: BrowserRemoteObservabilityCompatibility,
): BrowserRemoteObservabilityCompatibility {
  const record = asRecord(input, 'BrowserRemoteObservabilityCompatibility');
  exactKeys(record, COMPATIBILITY_KEYS, 'BrowserRemoteObservabilityCompatibility');
  if (stableSha256(record) !== stableSha256(expected)) {
    throw new TypeError('BrowserRemoteObservabilityCompatibility no es canónica.');
  }
  return expected;
}

function result(
  reasonsInput: readonly BrowserRemoteObservabilityConsumerPacketCompatibilityReason[],
  packetFingerprint: string | null,
  manifestFingerprint: string | null,
  compatibilityFingerprint: string | null,
): BrowserRemoteObservabilityConsumerPacketCompatibility {
  const reasons = Object.freeze(
    [...new Set(reasonsInput)].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core: ResultCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: reasons.length === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE',
    reasons,
    packet_fingerprint: packetFingerprint,
    manifest_fingerprint: manifestFingerprint,
    compatibility_fingerprint: compatibilityFingerprint,
    network_access: false,
    external_mutation: false,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function browserRemoteObservabilityConsumerPacketCompatibility(
  packetInput: unknown,
  manifestInput: unknown,
  consumerInput: unknown,
  compatibilityInput: unknown,
): BrowserRemoteObservabilityConsumerPacketCompatibility {
  const reasons: BrowserRemoteObservabilityConsumerPacketCompatibilityReason[] = [];
  let packet: BrowserRemoteObservabilityConsumerPacket | null = null;
  try { packet = canonicalPacket(packetInput); } catch { reasons.push('PACKET_INVALID'); }

  let manifest: BrowserRemoteObservabilityManifest | null = null;
  try { manifest = canonicalManifest(manifestInput); } catch { reasons.push('MANIFEST_INVALID'); }

  let expectedCompatibility: BrowserRemoteObservabilityCompatibility | null = null;
  let compatibility: BrowserRemoteObservabilityCompatibility | null = null;
  if (manifest !== null) {
    expectedCompatibility = browserRemoteObservabilityCompatibility(manifest, consumerInput);
    try {
      compatibility = canonicalCompatibility(compatibilityInput, expectedCompatibility);
    } catch {
      reasons.push('COMPATIBILITY_INVALID');
    }
    if (expectedCompatibility.status !== 'COMPATIBLE') reasons.push('CONSUMER_INCOMPATIBLE');
  }

  if (packet !== null && manifest !== null && packet.manifest_fingerprint !== manifest.fingerprint) {
    reasons.push('PROVENANCE_MISMATCH');
  }

  return result(
    reasons,
    packet?.fingerprint ?? null,
    manifest?.fingerprint ?? null,
    compatibility?.fingerprint ?? expectedCompatibility?.fingerprint ?? null,
  );
}
