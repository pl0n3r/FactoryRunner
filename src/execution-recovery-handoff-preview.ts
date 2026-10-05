import { executionRecoveryHandoffVerify } from './execution-recovery-handoff-verify.ts';
import { stableSha256 } from './validation.ts';

export type ExecutionRecoveryHandoffPreview =
  | Readonly<{
      version: 1;
      authority: 'unchanged';
      status: 'READY';
      verified: true;
      execution_id: string;
      handoff_fingerprint: string;
      readiness_fingerprint: string;
      snapshot_fingerprint: string;
      plan_fingerprint: string;
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
      reason: 'handoff_unverified';
      execution: false;
      network_access: false;
      external_mutation: false;
      fingerprint: string;
    }>;

function unknownPreview(): ExecutionRecoveryHandoffPreview {
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: 'UNKNOWN' as const,
    verified: false as const,
    reason: 'handoff_unverified' as const,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionRecoveryHandoffPreview(
  packetInput: unknown,
  executionIdInput: unknown,
  readinessInput: unknown,
  snapshotFingerprintInput: unknown,
  planFingerprintInput: unknown,
): ExecutionRecoveryHandoffPreview {
  try {
    const verified = executionRecoveryHandoffVerify(
      packetInput,
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
      handoff_fingerprint: verified.handoff_fingerprint,
      readiness_fingerprint: verified.readiness_fingerprint,
      snapshot_fingerprint: verified.snapshot_fingerprint,
      plan_fingerprint: verified.plan_fingerprint,
      execution: false as const,
      network_access: false as const,
      external_mutation: false as const,
    });
    return Object.freeze({ ...core, fingerprint: stableSha256(core) });
  } catch {
    return unknownPreview();
  }
}
