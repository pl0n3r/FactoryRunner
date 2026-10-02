import type { ExecutionEvidence, ExecutionEvent, ExecutionState } from './event.ts';
import { parseExecutionEvent } from './event.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import type { ExecutionOrder } from './order.ts';
import { orderFingerprint, parseExecutionOrder } from './order.ts';
import type { RunnerHeartbeat, RunnerIdentity } from './runner.ts';
import {
  assertHeartbeatMatchesIdentity,
  availableCapacity,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from './runner.ts';
import { asRecord, exactKeys, integer, ref, stableSha256, uuid } from './validation.ts';

const TERMINAL_STATES = new Set<ExecutionState>(['failed', 'completed', 'cancelled']);

export type ExecutionResultEnvelope = {
  version: 1;
  order_id: string;
  runner_id: string;
  sequence: number;
  state: 'failed' | 'completed' | 'cancelled';
  occurred_at: number;
  evidence: ExecutionEvidence;
};

export type PlanBoundExecutionResultEnvelope = ExecutionResultEnvelope & {
  authority: 'unchanged';
  plan_fingerprint: string;
  fingerprint: string;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const PLAN_KEYS = [
  'version',
  'authority',
  'runner_id',
  'order_id',
  'work_item_id',
  'capability',
  'order_fingerprint',
  'admission_fingerprint',
  'adapter_id',
  'manifest_fingerprint',
  'resource_fingerprint',
  'fingerprint',
] as const;

function sha256(value: unknown, field: string): string {
  const parsed = ref(value, field, 64).toLowerCase();
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
  return parsed;
}

function planFingerprint(
  planInput: unknown,
  order: ExecutionOrder,
): string {
  const record = asRecord(planInput, 'ExecutionPlan');
  exactKeys(record, PLAN_KEYS, 'ExecutionPlan');
  if (record.version !== 1 || record.authority !== 'unchanged') {
    throw new TypeError('ExecutionPlan no conserva autoridad.');
  }

  if (
    uuid(record.runner_id, 'plan.runner_id') !== order.runner_id
    || uuid(record.order_id, 'plan.order_id') !== order.order_id
    || ref(record.work_item_id, 'plan.work_item_id', 160) !== order.work_item_id
    || ref(record.capability, 'plan.capability', 128) !== order.capability
    || sha256(record.order_fingerprint, 'plan.order_fingerprint') !== orderFingerprint(order)
  ) {
    throw new TypeError('ExecutionPlan no corresponde a la orden.');
  }

  sha256(record.admission_fingerprint, 'plan.admission_fingerprint');
  ref(record.adapter_id, 'plan.adapter_id', 64);
  sha256(record.manifest_fingerprint, 'plan.manifest_fingerprint');
  sha256(record.resource_fingerprint, 'plan.resource_fingerprint');
  const fingerprint = sha256(record.fingerprint, 'plan.fingerprint');
  const { fingerprint: _ignored, ...core } = record;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionPlan fingerprint incoherente.');
  }
  return fingerprint;
}

export type ObservedQueueState = {
  version: 1;
  runner_id: string;
  observed_at: number;
  queued_orders: number;
};

export type CapacitySnapshot = {
  version: 1;
  runner_id: string;
  observed_at: number;
  heartbeat_sequence: number;
  runner_status: RunnerHeartbeat['status'];
  max_parallel: number;
  active: number;
  available: number;
  queued_orders: number;
  dispatchable_orders: number;
};

export function resultEnvelope(orderInput: unknown, eventInput: unknown): ExecutionResultEnvelope {
  const order: ExecutionOrder = parseExecutionOrder(orderInput);
  const event: ExecutionEvent = parseExecutionEvent(eventInput);

  if (event.order_id !== order.order_id || event.runner_id !== order.runner_id) {
    throw new TypeError('Resultado pertenece a otra orden o runner.');
  }
  if (!TERMINAL_STATES.has(event.state)) {
    throw new TypeError('Resultado requiere estado terminal.');
  }

  return {
    version: 1,
    order_id: event.order_id,
    runner_id: event.runner_id,
    sequence: event.sequence,
    state: event.state as ExecutionResultEnvelope['state'],
    occurred_at: event.occurred_at,
    evidence: { ...event.evidence },
  };
}

export function planResultEnvelope(
  orderInput: unknown,
  eventInput: unknown,
  planInput: unknown,
): PlanBoundExecutionResultEnvelope {
  const order = parseExecutionOrder(orderInput);
  const result = resultEnvelope(order, eventInput);
  const planHash = planFingerprint(planInput as ExecutionPlan, order);
  const core = {
    ...result,
    authority: 'unchanged' as const,
    plan_fingerprint: planHash,
  };
  return Object.freeze({
    ...core,
    evidence: Object.freeze({ ...core.evidence }),
    fingerprint: stableSha256(core),
  });
}

function parseQueueState(input: unknown): ObservedQueueState {
  const record = asRecord(input, 'ObservedQueueState');
  exactKeys(record, ['version', 'runner_id', 'observed_at', 'queued_orders'], 'ObservedQueueState');
  if (record.version !== 1) throw new TypeError('Versión de ObservedQueueState no soportada.');

  return {
    version: 1,
    runner_id: uuid(record.runner_id, 'queue.runner_id'),
    observed_at: integer(record.observed_at, 'queue.observed_at'),
    queued_orders: integer(record.queued_orders, 'queue.queued_orders'),
  };
}

export function capacitySnapshot(
  identityInput: unknown,
  heartbeatInput: unknown,
  queueInput: unknown,
  nowInput: unknown,
): CapacitySnapshot {
  const identity: RunnerIdentity = parseRunnerIdentity(identityInput);
  const heartbeat: RunnerHeartbeat = parseRunnerHeartbeat(heartbeatInput);
  const queue = parseQueueState(queueInput);
  const now = integer(nowInput, 'now');

  assertHeartbeatMatchesIdentity(identity, heartbeat);
  if (queue.runner_id !== identity.runner_id) {
    throw new TypeError('Queue state pertenece a otro runner.');
  }
  if (queue.observed_at !== heartbeat.observed_at) {
    throw new TypeError('Queue state y heartbeat no pertenecen al mismo snapshot.');
  }
  if (queue.observed_at > now) {
    throw new TypeError('Queue state observado en el futuro.');
  }

  const available = availableCapacity(identity, heartbeat, now);
  return {
    version: 1,
    runner_id: identity.runner_id,
    observed_at: queue.observed_at,
    heartbeat_sequence: heartbeat.sequence,
    runner_status: heartbeat.status,
    max_parallel: identity.max_parallel,
    active: heartbeat.capacity.active,
    available,
    queued_orders: queue.queued_orders,
    dispatchable_orders: Math.min(available, queue.queued_orders),
  };
}
