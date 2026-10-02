import {
  parseExecutionEvent,
  type ExecutionEvidence,
  type ExecutionEvent,
} from './event.ts';
import { planResultEnvelope } from './result.ts';
import { stableSha256 } from './validation.ts';

type TerminalExecutionState = 'failed' | 'completed' | 'cancelled';

export type PlanTerminalEvent = Omit<ExecutionEvent, 'state' | 'evidence'> & {
  state: TerminalExecutionState;
  evidence: Readonly<ExecutionEvidence>;
};

export type PlanEventBatch = {
  version: 1;
  authority: 'unchanged';
  order_id: string;
  runner_id: string;
  plan_fingerprint: string;
  events: readonly PlanTerminalEvent[];
  fingerprint: string;
};

type PlanEventBatchCore = Omit<PlanEventBatch, 'fingerprint'>;

export function planEventBatch(
  orderInput: unknown,
  eventsInput: unknown,
  planInput: unknown,
): PlanEventBatch {
  if (!Array.isArray(eventsInput) || eventsInput.length === 0 || eventsInput.length > 128) {
    throw new TypeError('Batch terminal inválido.');
  }

  let orderId: string | undefined;
  let runnerId: string | undefined;
  let planFingerprint: string | undefined;
  const normalized: PlanTerminalEvent[] = [];

  for (const eventInput of eventsInput) {
    const event = parseExecutionEvent(eventInput);
    const envelope = planResultEnvelope(orderInput, event, planInput);

    if (orderId === undefined) {
      orderId = envelope.order_id;
      runnerId = envelope.runner_id;
      planFingerprint = envelope.plan_fingerprint;
    } else if (
      envelope.order_id !== orderId
      || envelope.runner_id !== runnerId
      || envelope.plan_fingerprint !== planFingerprint
    ) {
      throw new TypeError('Batch terminal mezcla orden, runner o ExecutionPlan.');
    }

    normalized.push(Object.freeze({
      ...event,
      state: envelope.state,
      evidence: Object.freeze({ ...envelope.evidence }),
    }));
  }

  if (orderId === undefined || runnerId === undefined || planFingerprint === undefined) {
    throw new TypeError('Batch terminal vacío.');
  }

  const events = Object.freeze(normalized);
  const core: PlanEventBatchCore = {
    version: 1,
    authority: 'unchanged',
    order_id: orderId,
    runner_id: runnerId,
    plan_fingerprint: planFingerprint,
    events,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
