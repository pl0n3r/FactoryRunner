import {
  executionRecoveryHandoffManifest,
  type ExecutionRecoveryHandoffManifest,
} from './execution-recovery-handoff-manifest.ts';
import { asRecord, exactKeys, stableSha256 } from './validation.ts';

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

function assertManifestShape(input: unknown): asserts input is ExecutionRecoveryHandoffManifest {
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
  assertManifestShape(manifestInput);
  const expected = executionRecoveryHandoffManifest(
    packetInput,
    verificationInput,
    previewInput,
    executionIdInput,
    readinessInput,
    snapshotFingerprintInput,
    planFingerprintInput,
  );

  if (stableSha256(manifestInput) !== stableSha256(expected)) {
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
