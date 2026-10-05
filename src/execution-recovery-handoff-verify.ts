import type { ExecutionRecoveryReadiness } from './execution-recovery-readiness.ts';
import {
  executionRecoveryHandoffPacket,
  type ExecutionRecoveryHandoffPacket,
} from './execution-recovery-handoff-packet.ts';
import { asRecord, exactKeys, ref, stableSha256 } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;

export type ExecutionRecoveryHandoffVerification = Readonly<{
  version: 1;
  authority: 'unchanged';
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
}>;

function sha256(input: unknown, label: string): string {
  const value = ref(input, label, 64).toLowerCase();
  if (!SHA256_RE.test(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function parsePacket(input: unknown): ExecutionRecoveryHandoffPacket {
  const record = asRecord(input, 'ExecutionRecoveryHandoffPacket');
  exactKeys(record, [
    'version',
    'authority',
    'execution_id',
    'readiness_fingerprint',
    'snapshot_fingerprint',
    'plan_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'fingerprint',
  ], 'ExecutionRecoveryHandoffPacket');

  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryHandoffPacket cambia schema, authority o effects.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: ref(record.execution_id, 'packet.execution_id', 160),
    readiness_fingerprint: sha256(
      record.readiness_fingerprint,
      'packet.readiness_fingerprint',
    ),
    snapshot_fingerprint: sha256(
      record.snapshot_fingerprint,
      'packet.snapshot_fingerprint',
    ),
    plan_fingerprint: sha256(record.plan_fingerprint, 'packet.plan_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = sha256(record.fingerprint, 'packet.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryHandoffPacket fingerprint inválido.');
  }

  return Object.freeze({ ...core, fingerprint });
}

export function executionRecoveryHandoffVerify(
  packetInput: unknown,
  executionIdInput: unknown,
  readinessInput: unknown,
  snapshotFingerprintInput: unknown,
  planFingerprintInput: unknown,
): ExecutionRecoveryHandoffVerification {
  const packet = parsePacket(packetInput);
  const expected = executionRecoveryHandoffPacket(
    executionIdInput,
    readinessInput as ExecutionRecoveryReadiness,
    snapshotFingerprintInput,
    planFingerprintInput,
  );

  if (stableSha256(packet) !== stableSha256(expected)) {
    throw new TypeError('Recovery handoff no coincide con la evidencia exacta.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    verified: true as const,
    execution_id: expected.execution_id,
    handoff_fingerprint: expected.fingerprint,
    readiness_fingerprint: expected.readiness_fingerprint,
    snapshot_fingerprint: expected.snapshot_fingerprint,
    plan_fingerprint: expected.plan_fingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
