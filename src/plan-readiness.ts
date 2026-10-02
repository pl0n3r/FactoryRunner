import { planEventBatch } from './plan-event-batch.ts';
import { planTelemetry } from './plan-telemetry.ts';
import { heartbeatHealth, parseRunnerHeartbeat } from './runner.ts';
import {
  asRecord,
  exactKeys,
  integer,
  ref,
  slug,
  stableSha256,
  uuid,
} from './validation.ts';

export type PlanReadiness = {
  version: 1;
  authority: 'unchanged';
  status: 'READY';
  runner_id: string;
  order_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  telemetry_fingerprint: string;
  batch_fingerprint: string;
  terminal_occurred_at: number;
  heartbeat_sequence: number;
  heartbeat_observed_at: number;
  runner_status: 'ready' | 'busy';
  fingerprint: string;
};

type PlanReadinessCore = Omit<PlanReadiness, 'fingerprint'>;

const TELEMETRY_KEYS = [
  'version',
  'authority',
  'runner_id',
  'order_id',
  'plan_fingerprint',
  'adapter_id',
  'fingerprint',
] as const;

const BATCH_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'plan_fingerprint',
  'events',
  'fingerprint',
] as const;

export function planReadiness(
  orderInput: unknown,
  planInput: unknown,
  telemetryInput: unknown,
  batchInput: unknown,
  heartbeatInput: unknown,
  nowInput: unknown,
  terminalStaleAfterSecondsInput: unknown = 300,
): PlanReadiness {
  const now = integer(nowInput, 'now');
  const terminalStaleAfterSeconds = integer(
    terminalStaleAfterSecondsInput,
    'terminalStaleAfterSeconds',
    1,
  );

  const telemetryRecord = asRecord(telemetryInput, 'PlanTelemetry');
  exactKeys(telemetryRecord, TELEMETRY_KEYS, 'PlanTelemetry');
  if (telemetryRecord.version !== 1 || telemetryRecord.authority !== 'unchanged') {
    throw new TypeError('PlanTelemetry no conserva autoridad.');
  }

  const telemetryAdapter = slug(telemetryRecord.adapter_id, 'telemetry.adapter_id');
  const canonicalTelemetry = planTelemetry(orderInput, planInput, telemetryAdapter);
  if (
    uuid(telemetryRecord.runner_id, 'telemetry.runner_id') !== canonicalTelemetry.runner_id
    || uuid(telemetryRecord.order_id, 'telemetry.order_id') !== canonicalTelemetry.order_id
    || ref(telemetryRecord.plan_fingerprint, 'telemetry.plan_fingerprint', 64)
      !== canonicalTelemetry.plan_fingerprint
    || ref(telemetryRecord.fingerprint, 'telemetry.fingerprint', 64)
      !== canonicalTelemetry.fingerprint
  ) {
    throw new TypeError('PlanTelemetry no corresponde al ExecutionPlan ejecutado.');
  }

  const batchRecord = asRecord(batchInput, 'PlanEventBatch');
  exactKeys(batchRecord, BATCH_KEYS, 'PlanEventBatch');
  if (
    batchRecord.version !== 1
    || batchRecord.authority !== 'unchanged'
    || !Array.isArray(batchRecord.events)
    || batchRecord.events.length !== 1
  ) {
    throw new TypeError('PlanEventBatch no es una evidencia terminal única.');
  }

  const canonicalBatch = planEventBatch(orderInput, batchRecord.events, planInput);
  if (
    uuid(batchRecord.runner_id, 'batch.runner_id') !== canonicalBatch.runner_id
    || uuid(batchRecord.order_id, 'batch.order_id') !== canonicalBatch.order_id
    || ref(batchRecord.plan_fingerprint, 'batch.plan_fingerprint', 64)
      !== canonicalBatch.plan_fingerprint
    || ref(batchRecord.fingerprint, 'batch.fingerprint', 64)
      !== canonicalBatch.fingerprint
    || canonicalBatch.plan_fingerprint !== canonicalTelemetry.plan_fingerprint
  ) {
    throw new TypeError('PlanEventBatch no corresponde al mismo ExecutionPlan.');
  }

  const terminal = canonicalBatch.events[0];
  if (terminal === undefined || terminal.state !== 'completed') {
    throw new TypeError('Readiness requiere evidencia terminal completed.');
  }
  if (
    terminal.occurred_at > now
    || now - terminal.occurred_at > terminalStaleAfterSeconds
  ) {
    throw new TypeError('Evidencia terminal stale o futura.');
  }

  const heartbeat = parseRunnerHeartbeat(heartbeatInput);
  if (
    heartbeat.runner_id !== canonicalTelemetry.runner_id
    || heartbeatHealth(heartbeat, now) !== 'healthy'
    || (heartbeat.status !== 'ready' && heartbeat.status !== 'busy')
  ) {
    throw new TypeError('Runtime no está healthy para readiness.');
  }

  const core: PlanReadinessCore = {
    version: 1,
    authority: 'unchanged',
    status: 'READY',
    runner_id: canonicalTelemetry.runner_id,
    order_id: canonicalTelemetry.order_id,
    plan_fingerprint: canonicalTelemetry.plan_fingerprint,
    adapter_id: canonicalTelemetry.adapter_id,
    telemetry_fingerprint: canonicalTelemetry.fingerprint,
    batch_fingerprint: canonicalBatch.fingerprint,
    terminal_occurred_at: terminal.occurred_at,
    heartbeat_sequence: heartbeat.sequence,
    heartbeat_observed_at: heartbeat.observed_at,
    runner_status: heartbeat.status,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
