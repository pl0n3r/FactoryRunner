import { planDoctor } from './plan-doctor.ts';
import { planEventBatch } from './plan-event-batch.ts';
import {
  asRecord,
  exactKeys,
  ref,
  stableSha256,
  uuid,
} from './validation.ts';

export type PlanAuditBundle = {
  version: 1;
  authority: 'unchanged';
  status: 'AUDIT_READY';
  runner_id: string;
  order_id: string;
  adapter_id: string;
  plan_fingerprint: string;
  batch_fingerprint: string;
  telemetry_fingerprint: string;
  readiness_fingerprint: string;
  doctor_fingerprint: string;
  fingerprint: string;
};

type PlanAuditCore = Omit<PlanAuditBundle, 'fingerprint'>;

const BATCH_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'plan_fingerprint',
  'events',
  'fingerprint',
] as const;

const READINESS_KEYS = [
  'version',
  'authority',
  'status',
  'runner_id',
  'order_id',
  'plan_fingerprint',
  'adapter_id',
  'telemetry_fingerprint',
  'batch_fingerprint',
  'terminal_occurred_at',
  'heartbeat_sequence',
  'heartbeat_observed_at',
  'runner_status',
  'fingerprint',
] as const;

export function planAuditBundle(
  orderInput: unknown,
  planInput: unknown,
  batchInput: unknown,
  telemetryInput: unknown,
  readinessInput: unknown,
): PlanAuditBundle {
  const doctor = planDoctor(orderInput, planInput, telemetryInput, readinessInput);

  const batch = asRecord(batchInput, 'PlanEventBatch');
  exactKeys(batch, BATCH_KEYS, 'PlanEventBatch');
  if (
    batch.version !== 1
    || batch.authority !== 'unchanged'
    || !Array.isArray(batch.events)
    || batch.events.length !== 1
  ) {
    throw new TypeError('PlanEventBatch inválido para auditoría.');
  }

  const canonicalBatch = planEventBatch(orderInput, batch.events, planInput);
  if (
    uuid(batch.runner_id, 'batch.runner_id') !== canonicalBatch.runner_id
    || uuid(batch.order_id, 'batch.order_id') !== canonicalBatch.order_id
    || ref(batch.plan_fingerprint, 'batch.plan_fingerprint', 64) !== canonicalBatch.plan_fingerprint
    || ref(batch.fingerprint, 'batch.fingerprint', 64) !== canonicalBatch.fingerprint
  ) {
    throw new TypeError('PlanEventBatch conflictivo para auditoría.');
  }

  const readiness = asRecord(readinessInput, 'PlanReadiness');
  exactKeys(readiness, READINESS_KEYS, 'PlanReadiness');
  const readinessBatchFingerprint = ref(readiness.batch_fingerprint, 'readiness.batch_fingerprint', 64);
  if (
    readinessBatchFingerprint !== canonicalBatch.fingerprint
    || canonicalBatch.plan_fingerprint !== doctor.plan_fingerprint
    || canonicalBatch.runner_id !== doctor.runner_id
    || canonicalBatch.order_id !== doctor.order_id
  ) {
    throw new TypeError('Readiness y batch no pertenecen a la misma ejecución.');
  }

  const core: PlanAuditCore = {
    version: 1,
    authority: 'unchanged',
    status: 'AUDIT_READY',
    runner_id: doctor.runner_id,
    order_id: doctor.order_id,
    adapter_id: doctor.adapter_id,
    plan_fingerprint: doctor.plan_fingerprint,
    batch_fingerprint: canonicalBatch.fingerprint,
    telemetry_fingerprint: doctor.telemetry_fingerprint,
    readiness_fingerprint: doctor.readiness_fingerprint,
    doctor_fingerprint: doctor.fingerprint,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
