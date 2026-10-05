import { executionRecoveryHandoffManifestVerify } from './execution-recovery-handoff-manifest-verify.ts';
import { stableSha256 } from './validation.ts';

export type ExecutionRecoveryHandoffManifestPreview =
  | Readonly<{
      version: 1;
      authority: 'unchanged';
      status: 'READY';
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
    }>
  | Readonly<{
      version: 1;
      authority: 'unchanged';
      status: 'UNKNOWN';
      verified: false;
      reason: 'manifest_unverified';
      execution: false;
      network_access: false;
      external_mutation: false;
      fingerprint: string;
    }>;

function unknownPreview(): ExecutionRecoveryHandoffManifestPreview {
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: 'UNKNOWN' as const,
    verified: false as const,
    reason: 'manifest_unverified' as const,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionRecoveryHandoffManifestPreview(
  manifestInput: unknown,
  packetInput: unknown,
  verificationInput: unknown,
  previewInput: unknown,
  executionIdInput: unknown,
  readinessInput: unknown,
  snapshotFingerprintInput: unknown,
  planFingerprintInput: unknown,
): ExecutionRecoveryHandoffManifestPreview {
  try {
    const verified = executionRecoveryHandoffManifestVerify(
      manifestInput,
      packetInput,
      verificationInput,
      previewInput,
      executionIdInput,
      readinessInput,
      snapshotFingerprintInput,
      planFingerprintInput,
    );

    const core = Object.freeze({
      version: 1 as const,
      authority: 'unchanged' as const,
      status: 'READY' as const,
      verified: true as const,
      execution_id: verified.execution_id,
      manifest_fingerprint: verified.manifest_fingerprint,
      packet_fingerprint: verified.packet_fingerprint,
      verification_fingerprint: verified.verification_fingerprint,
      preview_fingerprint: verified.preview_fingerprint,
      execution: false as const,
      network_access: false as const,
      external_mutation: false as const,
    });
    return Object.freeze({ ...core, fingerprint: stableSha256(core) });
  } catch {
    return unknownPreview();
  }
}
