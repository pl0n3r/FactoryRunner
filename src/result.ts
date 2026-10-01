import type { ExecutionEvidence, ExecutionEvent, ExecutionState } from './event.ts';
import { parseExecutionEvent } from './event.ts';
import type { ExecutionOrder } from './order.ts';
import { parseExecutionOrder } from './order.ts';
import type { RunnerHeartbeat, RunnerIdentity } from './runner.ts';
import {
  assertHeartbeatMatchesIdentity,
  availableCapacity,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from './runner.ts';
import { asRecord, exactKeys, integer, uuid } from './validation.ts';

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
