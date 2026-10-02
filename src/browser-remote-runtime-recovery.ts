import type { OutboxDelivery, DurableOutbox } from './outbox.ts';
import type { DurableJournal } from './journal.ts';
import type { ExecutionState } from './event.ts';
import { stableSha256, uuid } from './validation.ts';

export type BrowserRemoteRecoveryState = 'absent' | 'accepted' | 'interrupted' | 'terminal';

export type BrowserRemoteRecoveryEvidence = {
  version: 1;
  order_id: string;
  recovery: BrowserRemoteRecoveryState;
  replay_allowed: boolean;
  last_state: ExecutionState | null;
  evidence_code: string | null;
  pending_delivery_kinds: readonly OutboxDelivery['kind'][];
  delivered_delivery_kinds: readonly OutboxDelivery['kind'][];
  fingerprint: string;
};

function belongsToOrder(delivery: OutboxDelivery, orderId: string): boolean {
  if (delivery.kind === 'ack') return delivery.request.order_id === orderId;
  return delivery.request.events.some((event) => event.order_id === orderId);
}

function kinds(deliveries: readonly OutboxDelivery[], orderId: string): readonly OutboxDelivery['kind'][] {
  return Object.freeze(
    [...new Set(
      deliveries
        .filter((delivery) => belongsToOrder(delivery, orderId))
        .map((delivery) => delivery.kind),
    )].sort((a, b) => a.localeCompare(b, 'en')),
  );
}

export function browserRemoteRecoveryEvidence(
  journal: DurableJournal,
  outbox: DurableOutbox,
  orderIdInput: unknown,
): BrowserRemoteRecoveryEvidence {
  const orderId = uuid(orderIdInput, 'order_id');
  const execution = journal.recoverExecution(orderId);
  const recoveredOutbox = outbox.recover();
  const recovery: BrowserRemoteRecoveryState = execution?.recovery ?? 'absent';
  const core = {
    version: 1 as const,
    order_id: orderId,
    recovery,
    replay_allowed: recovery === 'absent' || recovery === 'accepted',
    last_state: execution?.last_event?.state ?? null,
    evidence_code: execution?.last_event?.evidence.code ?? null,
    pending_delivery_kinds: kinds(recoveredOutbox.pending, orderId),
    delivered_delivery_kinds: kinds(recoveredOutbox.delivered, orderId),
  };
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
