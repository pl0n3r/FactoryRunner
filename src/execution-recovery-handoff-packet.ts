import type { ExecutionRecoveryReadiness } from './execution-recovery-readiness.ts';
import { asRecord, exactKeys, integer, ref, stableSha256 } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ORDERS = 1_024;

export type ExecutionRecoveryHandoffPacket = Readonly<{
  version: 1;
  authority: 'unchanged';
  execution_id: string;
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

function parseReadiness(input: unknown): ExecutionRecoveryReadiness {
  const record = asRecord(input, 'ExecutionRecoveryReadiness');
  exactKeys(record, [
    'version',
    'authority',
    'ready',
    'reason',
    'snapshot_fingerprint',
    'plan_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'counts',
    'fingerprint',
  ], 'ExecutionRecoveryReadiness');

  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.ready !== true
    || record.reason !== 'ready'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryReadiness no está lista o cambia authority.');
  }

  const countsRecord = asRecord(record.counts, 'readiness.counts');
  exactKeys(
    countsRecord,
    ['orders', 'noop', 'redeliver', 'resume', 'block'],
    'readiness.counts',
  );
  const counts = Object.freeze({
    orders: integer(countsRecord.orders, 'readiness.counts.orders', 0, MAX_ORDERS),
    noop: integer(countsRecord.noop, 'readiness.counts.noop', 0, MAX_ORDERS),
    redeliver: integer(countsRecord.redeliver, 'readiness.counts.redeliver', 0, MAX_ORDERS),
    resume: integer(countsRecord.resume, 'readiness.counts.resume', 0, MAX_ORDERS),
    block: integer(countsRecord.block, 'readiness.counts.block', 0, MAX_ORDERS),
  });
  if (
    counts.block !== 0
    || counts.orders !== counts.noop + counts.redeliver + counts.resume + counts.block
  ) {
    throw new TypeError('ExecutionRecoveryReadiness counts inválidos.');
  }

  const snapshotFingerprint = sha256(
    record.snapshot_fingerprint,
    'readiness.snapshot_fingerprint',
  );
  const planFingerprint = sha256(
    record.plan_fingerprint,
    'readiness.plan_fingerprint',
  );
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    ready: true,
    reason: 'ready' as const,
    snapshot_fingerprint: snapshotFingerprint,
    plan_fingerprint: planFingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
    counts,
  });
  const fingerprint = sha256(record.fingerprint, 'readiness.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryReadiness fingerprint inválido.');
  }

  return Object.freeze({ ...core, fingerprint });
}

export function executionRecoveryHandoffPacket(
  executionIdInput: unknown,
  readinessInput: unknown,
): ExecutionRecoveryHandoffPacket {
  const executionId = ref(executionIdInput, 'execution_id', 160);
  const readiness = parseReadiness(readinessInput);

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: executionId,
    readiness_fingerprint: readiness.fingerprint,
    snapshot_fingerprint: readiness.snapshot_fingerprint as string,
    plan_fingerprint: readiness.plan_fingerprint as string,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
