import {
  executionRecoveryHandoffManifest,
  type ExecutionRecoveryHandoffManifest,
} from './execution-recovery-handoff-manifest.ts';
import { asRecord, exactKeys, ref, stableSha256 } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;

export type ExecutionRecoveryHandoffManifestVerification = Readonly<{
  version: 1;
  authority: 'unchanged';
  verified: true;
  execution_id: string;
  manifest_fingerprint: string;
  packet_fingerprint: string;
  verification_fingerprint: string;
  preview_fingerprint: string;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

function sha256(input: unknown, label: string): string {
  const value = ref(input, label, 64).toLowerCase();
  if (!SHA256_RE.test(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function parseManifest(input: unknown): ExecutionRecoveryHandoffManifest {
  const record = asRecord(input, 'ExecutionRecoveryHandoffManifest');
  exactKeys(record, [
    'version',
    'authority',
    'execution_id',
    'packet_fingerprint',
    'verification_fingerprint',
    'preview_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'fingerprint',
  ], 'ExecutionRecoveryHandoffManifest');

  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryHandoffManifest cambia schema, authority o effects.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: ref(record.execution_id, 'manifest.execution_id', 160),
    packet_fingerprint: sha256(record.packet_fingerprint, 'manifest.packet_fingerprint'),
    verification_fingerprint: sha256(
      record.verification_fingerprint,
      'manifest.verification_fingerprint',
    ),
    preview_fingerprint: sha256(record.preview_fingerprint, 'manifest.preview_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = sha256(record.fingerprint, 'manifest.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryHandoffManifest fingerprint inválido.');
  }

  return Object.freeze({ ...core, fingerprint });
}

export function executionRecoveryHandoffManifestVerify(
  manifestInput: unknown,
  packetInput: unknown,
  verificationInput: unknown,
  previewInput: unknown,
  executionIdInput: unknown,
  readinessInput: unknown,
  snapshotFingerprintInput: unknown,
  planFingerprintInput: unknown,
): ExecutionRecoveryHandoffManifestVerification {
  const manifest = parseManifest(manifestInput);
  const expected = executionRecoveryHandoffManifest(
    packetInput,
    verificationInput,
    previewInput,
    executionIdInput,
    readinessInput,
    snapshotFingerprintInput,
    planFingerprintInput,
  );

  if (stableSha256(manifest) !== stableSha256(expected)) {
    throw new TypeError('Recovery handoff manifest no coincide con la evidencia exacta.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    verified: true as const,
    execution_id: expected.execution_id,
    manifest_fingerprint: expected.fingerprint,
    packet_fingerprint: expected.packet_fingerprint,
    verification_fingerprint: expected.verification_fingerprint,
    preview_fingerprint: expected.preview_fingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
