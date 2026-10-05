import { executionRecoveryHandoffVerify } from './execution-recovery-handoff-verify.ts';
import { executionRecoveryHandoffPreview } from './execution-recovery-handoff-preview.ts';
import { stableSha256 } from './validation.ts';

export type ExecutionRecoveryHandoffManifest = Readonly<{
  version: 1;
  authority: 'unchanged';
  execution_id: string;
  packet_fingerprint: string;
  verification_fingerprint: string;
  preview_fingerprint: string;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

function requireExactEvidence(actual: unknown, expected: unknown, label: string): void {
  if (stableSha256(actual) !== stableSha256(expected)) {
    throw new TypeError(`${label} no coincide con la evidencia canónica.`);
  }
}

export function executionRecoveryHandoffManifest(
  packetInput: unknown,
  verificationInput: unknown,
  previewInput: unknown,
  executionIdInput: unknown,
  readinessInput: unknown,
  snapshotFingerprintInput: unknown,
  planFingerprintInput: unknown,
): ExecutionRecoveryHandoffManifest {
  const expectedVerification = executionRecoveryHandoffVerify(
    packetInput,
    executionIdInput,
    readinessInput,
    snapshotFingerprintInput,
    planFingerprintInput,
  );
  const expectedPreview = executionRecoveryHandoffPreview(
    packetInput,
    executionIdInput,
    readinessInput,
    snapshotFingerprintInput,
    planFingerprintInput,
  );

  if (expectedPreview.status !== 'READY' || expectedPreview.verified !== true) {
    throw new TypeError('Recovery handoff preview no está verificada.');
  }

  requireExactEvidence(
    verificationInput,
    expectedVerification,
    'ExecutionRecoveryHandoffVerification',
  );
  requireExactEvidence(
    previewInput,
    expectedPreview,
    'ExecutionRecoveryHandoffPreview',
  );

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: expectedVerification.execution_id,
    packet_fingerprint: expectedVerification.handoff_fingerprint,
    verification_fingerprint: expectedVerification.fingerprint,
    preview_fingerprint: expectedPreview.fingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
