import { planTelemetry } from './plan-telemetry.ts';
import {
  asRecord,
  exactKeys,
  ref,
  slug,
  stableSha256,
  uuid,
} from './validation.ts';

export type PlanDoctorReport = {
  version: 1;
  authority: 'unchanged';
  status: 'OK';
  runner_id: string;
  order_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  telemetry_fingerprint: string;
  readiness_fingerprint: string;
  fingerprint: string;
};

type PlanDoctorCore = Omit<PlanDoctorReport, 'fingerprint'>;

const TELEMETRY_KEYS = [
  'version',
  'authority',
  'runner_id',
  'order_id',
  'plan_fingerprint',
  'adapter_id',
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

function sameTelemetry(input: unknown, canonical: ReturnType<typeof planTelemetry>): void {
  const telemetry = asRecord(input, 'PlanTelemetry');
  exactKeys(telemetry, TELEMETRY_KEYS, 'PlanTelemetry');

  if (
    telemetry.version !== 1
    || telemetry.authority !== 'unchanged'
    || uuid(telemetry.runner_id, 'telemetry.runner_id') !== canonical.runner_id
    || uuid(telemetry.order_id, 'telemetry.order_id') !== canonical.order_id
    || ref(telemetry.plan_fingerprint, 'telemetry.plan_fingerprint', 64) !== canonical.plan_fingerprint
    || slug(telemetry.adapter_id, 'telemetry.adapter_id') !== canonical.adapter_id
    || ref(telemetry.fingerprint, 'telemetry.fingerprint', 64) !== canonical.fingerprint
  ) {
    throw new TypeError('PlanTelemetry conflictiva.');
  }
}

export function planDoctor(
  orderInput: unknown,
  planInput: unknown,
  telemetryInput: unknown,
  readinessInput: unknown,
): PlanDoctorReport {
  const telemetryRecord = asRecord(telemetryInput, 'PlanTelemetry');
  exactKeys(telemetryRecord, TELEMETRY_KEYS, 'PlanTelemetry');
  const adapterId = slug(telemetryRecord.adapter_id, 'telemetry.adapter_id');

  const canonicalTelemetry = planTelemetry(orderInput, planInput, adapterId);
  sameTelemetry(telemetryInput, canonicalTelemetry);

  const readiness = asRecord(readinessInput, 'PlanReadiness');
  exactKeys(readiness, READINESS_KEYS, 'PlanReadiness');

  if (
    readiness.version !== 1
    || readiness.authority !== 'unchanged'
    || readiness.status !== 'READY'
    || uuid(readiness.runner_id, 'readiness.runner_id') !== canonicalTelemetry.runner_id
    || uuid(readiness.order_id, 'readiness.order_id') !== canonicalTelemetry.order_id
    || ref(readiness.plan_fingerprint, 'readiness.plan_fingerprint', 64)
      !== canonicalTelemetry.plan_fingerprint
    || slug(readiness.adapter_id, 'readiness.adapter_id') !== canonicalTelemetry.adapter_id
    || ref(readiness.telemetry_fingerprint, 'readiness.telemetry_fingerprint', 64)
      !== canonicalTelemetry.fingerprint
  ) {
    throw new TypeError('PlanReadiness conflictiva.');
  }

  const readinessFingerprint = ref(readiness.fingerprint, 'readiness.fingerprint', 64);
  const { fingerprint: _ignored, ...readinessCore } = readiness;
  if (stableSha256(readinessCore) !== readinessFingerprint) {
    throw new TypeError('PlanReadiness fingerprint incoherente.');
  }

  const batchFingerprint = ref(readiness.batch_fingerprint, 'readiness.batch_fingerprint', 64);
  if (!/^[0-9a-f]{64}$/.test(batchFingerprint) || !/^[0-9a-f]{64}$/.test(readinessFingerprint)) {
    throw new TypeError('Provenance de readiness inválida.');
  }

  const core: PlanDoctorCore = {
    version: 1,
    authority: 'unchanged',
    status: 'OK',
    runner_id: canonicalTelemetry.runner_id,
    order_id: canonicalTelemetry.order_id,
    plan_fingerprint: canonicalTelemetry.plan_fingerprint,
    adapter_id: canonicalTelemetry.adapter_id,
    telemetry_fingerprint: canonicalTelemetry.fingerprint,
    readiness_fingerprint: readinessFingerprint,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
