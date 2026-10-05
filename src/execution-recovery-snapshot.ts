import type { ExecutionEvent, ExecutionState } from './event.ts';
import { parseExecutionEvent } from './event.ts';
import type { RecoveredJournal } from './journal.ts';
import type { ExecutionOrder } from './order.ts';
import { orderFingerprint, parseExecutionOrder } from './order.ts';
import type { OutboxDelivery, RecoveredOutbox } from './outbox.ts';
import { asRecord, exactKeys, ref, stableSha256, uuid } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set<ExecutionState>(['failed', 'completed', 'cancelled']);

export const EXECUTION_RECOVERY_LIMITS = Object.freeze({
  orders: 1_024,
  events: 8_192,
  deliveries: 4_096,
});

export type RecoveryClassification = 'pending' | 'interrupted' | 'terminal';
export type RecoveryDeliveryState = 'pending' | 'delivered';

export type RecoveryDeliveryEvidence = Readonly<{
  delivery_id: string;
  kind: OutboxDelivery['kind'];
  state: RecoveryDeliveryState;
  fingerprint: string;
  plan_fingerprint: string | null;
  event_ids: readonly string[];
}>;

export type ExecutionRecoveryEvidence = Readonly<{
  version: 1;
  order_id: string;
  runner_id: string;
  work_item_id: string;
  order_fingerprint: string;
  plan_fingerprint: string | null;
  recovery: RecoveryClassification;
  last_event_id: string | null;
  last_sequence: number;
  counts: Readonly<{
    events: number;
    pending_deliveries: number;
    delivered_deliveries: number;
  }>;
  deliveries: readonly RecoveryDeliveryEvidence[];
  fingerprint: string;
}>;

export type ExecutionRecoverySnapshot = Readonly<{
  version: 1;
  counts: Readonly<{
    orders: number;
    events: number;
    pending_deliveries: number;
    delivered_deliveries: number;
  }>;
  executions: readonly ExecutionRecoveryEvidence[];
  fingerprint: string;
}>;

export class ExecutionRecoverySnapshotError extends Error {
  readonly code = 'recovery_snapshot_invalid' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionRecoverySnapshotError';
  }
}

type AckRequest = Readonly<{
  version: 1;
  order_id: string;
  runner_id: string;
  fingerprint: string;
}>;

type EventsRequest = Readonly<{
  version: 1;
  runner_id: string;
  events: readonly ExecutionEvent[];
}>;

type NormalizedDelivery = Readonly<{
  kind: OutboxDelivery['kind'];
  delivery_id: string;
  fingerprint: string;
  plan_fingerprint: string | null;
  ack: AckRequest | null;
  events: EventsRequest | null;
}>;

type DeliveryBucket = {
  deliveries: RecoveryDeliveryEvidence[];
  plan_fingerprints: Set<string>;
  has_plan_events: boolean;
  has_unbound_events: boolean;
  kind_counts: Map<OutboxDelivery['kind'], number>;
};

function invalid(message: string, cause?: unknown): never {
  throw new ExecutionRecoverySnapshotError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(input: unknown, label: string): string {
  const value = ref(input, label, 64).toLowerCase();
  if (!SHA256_RE.test(value)) invalid(`${label} must be lowercase sha256.`);
  return value;
}

function boundedArray<T>(input: unknown, limit: number, label: string): readonly T[] {
  if (!Array.isArray(input) || input.length > limit) {
    invalid(`${label} exceeds recovery snapshot bounds.`);
  }
  return input as readonly T[];
}

function parseAckRequest(input: unknown): AckRequest {
  const record = asRecord(input, 'recovery ack request');
  exactKeys(
    record,
    ['version', 'order_id', 'runner_id', 'fingerprint'],
    'recovery ack request',
  );
  if (record.version !== 1) invalid('Unsupported recovery ACK version.');
  return Object.freeze({
    version: 1,
    order_id: uuid(record.order_id, 'ack.order_id'),
    runner_id: uuid(record.runner_id, 'ack.runner_id'),
    fingerprint: sha256(record.fingerprint, 'ack.fingerprint'),
  });
}

function parseEventsRequest(input: unknown): EventsRequest {
  const record = asRecord(input, 'recovery events request');
  exactKeys(record, ['version', 'runner_id', 'events'], 'recovery events request');
  if (record.version !== 1) invalid('Unsupported recovery events version.');
  const runnerId = uuid(record.runner_id, 'events.runner_id');
  const rawEvents = boundedArray<unknown>(record.events, 128, 'delivery events');
  if (rawEvents.length === 0) invalid('Recovery delivery cannot contain an empty event batch.');
  const events = rawEvents.map((inputEvent) => parseExecutionEvent(inputEvent));
  if (events.some((event) => event.runner_id !== runnerId)) {
    invalid('Recovery delivery mixes runner identity.');
  }
  return Object.freeze({
    version: 1,
    runner_id: runnerId,
    events: Object.freeze(events),
  });
}

function normalizeDelivery(input: unknown): NormalizedDelivery {
  const record = asRecord(input, 'recovery delivery');
  if (record.kind === 'plan-events') {
    exactKeys(
      record,
      ['version', 'kind', 'delivery_id', 'fingerprint', 'plan_fingerprint', 'request'],
      'recovery delivery',
    );
  } else {
    exactKeys(
      record,
      ['version', 'kind', 'delivery_id', 'fingerprint', 'request'],
      'recovery delivery',
    );
  }
  if (
    record.version !== 1
    || (record.kind !== 'ack' && record.kind !== 'events' && record.kind !== 'plan-events')
  ) {
    invalid('Unsupported recovery delivery.');
  }

  const kind = record.kind as OutboxDelivery['kind'];
  const deliveryId = ref(record.delivery_id, 'delivery_id', 160);
  const fingerprint = sha256(record.fingerprint, 'delivery.fingerprint');
  const ack = kind === 'ack' ? parseAckRequest(record.request) : null;
  const events = kind === 'ack' ? null : parseEventsRequest(record.request);
  const planFingerprint = kind === 'plan-events'
    ? sha256(record.plan_fingerprint, 'plan_fingerprint')
    : null;
  const request = ack ?? events;
  const expectedFingerprint = kind === 'plan-events'
    ? stableSha256({ kind, plan_fingerprint: planFingerprint, request })
    : stableSha256({ kind, request });
  const expectedId = `outbox:${kind}:${expectedFingerprint}`;
  if (fingerprint !== expectedFingerprint || deliveryId !== expectedId) {
    invalid('Recovery delivery identity or fingerprint is inconsistent.');
  }

  return Object.freeze({
    kind,
    delivery_id: deliveryId,
    fingerprint,
    plan_fingerprint: planFingerprint,
    ack,
    events,
  });
}

function classify(events: readonly ExecutionEvent[]): RecoveryClassification {
  const last = events.at(-1);
  if (last === undefined || last.state === 'accepted') return 'pending';
  return TERMINAL_STATES.has(last.state) ? 'terminal' : 'interrupted';
}

function bucketFor(
  buckets: Map<string, DeliveryBucket>,
  orderId: string,
): DeliveryBucket {
  const existing = buckets.get(orderId);
  if (existing) return existing;
  const created: DeliveryBucket = {
    deliveries: [],
    plan_fingerprints: new Set<string>(),
    has_plan_events: false,
    has_unbound_events: false,
    kind_counts: new Map<OutboxDelivery['kind'], number>(),
  };
  buckets.set(orderId, created);
  return created;
}

function addDeliveryEvidence(
  buckets: Map<string, DeliveryBucket>,
  orderId: string,
  delivery: NormalizedDelivery,
  state: RecoveryDeliveryState,
  eventIds: readonly string[],
): void {
  const bucket = bucketFor(buckets, orderId);
  const kindCount = (bucket.kind_counts.get(delivery.kind) ?? 0) + 1;
  if (kindCount > 1) invalid(`Multiple ${delivery.kind} deliveries for the same order.`);
  bucket.kind_counts.set(delivery.kind, kindCount);
  if (delivery.kind === 'plan-events') {
    bucket.has_plan_events = true;
    bucket.plan_fingerprints.add(delivery.plan_fingerprint as string);
  } else if (delivery.kind === 'events') {
    bucket.has_unbound_events = true;
  }
  if (bucket.has_plan_events && bucket.has_unbound_events) {
    invalid('Mixed plan-bound and unbound delivery evidence for the same order.');
  }
  if (bucket.plan_fingerprints.size > 1) {
    invalid('Mixed plan fingerprints for the same recovered order.');
  }
  bucket.deliveries.push(Object.freeze({
    delivery_id: delivery.delivery_id,
    kind: delivery.kind,
    state,
    fingerprint: delivery.fingerprint,
    plan_fingerprint: delivery.plan_fingerprint,
    event_ids: Object.freeze([...eventIds]),
  }));
}

export function executionRecoverySnapshot(
  journalInput: RecoveredJournal,
  outboxInput: RecoveredOutbox,
): ExecutionRecoverySnapshot {
  const journalRecord = asRecord(journalInput, 'RecoveredJournal');
  exactKeys(journalRecord, ['orders', 'events'], 'RecoveredJournal');
  const outboxRecord = asRecord(outboxInput, 'RecoveredOutbox');
  exactKeys(outboxRecord, ['pending', 'delivered'], 'RecoveredOutbox');

  const rawOrders = boundedArray<unknown>(
    journalRecord.orders,
    EXECUTION_RECOVERY_LIMITS.orders,
    'recovered orders',
  );
  const rawEvents = boundedArray<unknown>(
    journalRecord.events,
    EXECUTION_RECOVERY_LIMITS.events,
    'recovered events',
  );
  const rawPending = boundedArray<unknown>(
    outboxRecord.pending,
    EXECUTION_RECOVERY_LIMITS.deliveries,
    'pending deliveries',
  );
  const rawDelivered = boundedArray<unknown>(
    outboxRecord.delivered,
    EXECUTION_RECOVERY_LIMITS.deliveries,
    'delivered deliveries',
  );
  if (rawPending.length + rawDelivered.length > EXECUTION_RECOVERY_LIMITS.deliveries) {
    invalid('Recovered deliveries exceed recovery snapshot bounds.');
  }

  const ordersById = new Map<string, ExecutionOrder>();
  for (const rawOrder of rawOrders) {
    const order = parseExecutionOrder(rawOrder);
    const existing = ordersById.get(order.order_id);
    if (existing !== undefined) {
      if (orderFingerprint(existing) !== orderFingerprint(order)) {
        invalid('Recovered journal contains a conflicting order identity.');
      }
      invalid('Recovered journal contains a duplicate order identity.');
    }
    ordersById.set(order.order_id, order);
  }

  const eventsById = new Map<string, ExecutionEvent>();
  const eventsByOrder = new Map<string, ExecutionEvent[]>();
  for (const rawEvent of rawEvents) {
    const event = parseExecutionEvent(rawEvent);
    if (eventsById.has(event.event_id)) {
      invalid('Recovered journal contains a duplicate event identity.');
    }
    const order = ordersById.get(event.order_id);
    if (order === undefined || order.runner_id !== event.runner_id) {
      invalid('Recovered journal event references an unknown order or runner.');
    }
    eventsById.set(event.event_id, event);
    const list = eventsByOrder.get(event.order_id) ?? [];
    list.push(event);
    eventsByOrder.set(event.order_id, list);
  }
  for (const [orderId, events] of eventsByOrder) {
    events.sort((left, right) => left.sequence - right.sequence);
    events.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        invalid(`Recovered journal sequence is not contiguous for ${orderId}.`);
      }
    });
  }

  const deliveryBuckets = new Map<string, DeliveryBucket>();
  const seenDeliveryIds = new Set<string>();
  const processDeliveries = (
    rawDeliveries: readonly unknown[],
    state: RecoveryDeliveryState,
  ): void => {
    for (const rawDelivery of rawDeliveries) {
      const delivery = normalizeDelivery(rawDelivery);
      if (seenDeliveryIds.has(delivery.delivery_id)) {
        invalid('Recovered outbox contains duplicate or mixed delivery state.');
      }
      seenDeliveryIds.add(delivery.delivery_id);

      if (delivery.ack !== null) {
        const order = ordersById.get(delivery.ack.order_id);
        if (order === undefined) invalid('Recovery delivery references an unknown order.');
        if (
          delivery.ack.runner_id !== order.runner_id
          || delivery.ack.fingerprint !== orderFingerprint(order)
        ) {
          invalid('ACK fingerprint does not match recovered order identity.');
        }
        if ((eventsByOrder.get(order.order_id)?.length ?? 0) === 0) {
          invalid('ACK exists without durable accepted event evidence.');
        }
        addDeliveryEvidence(deliveryBuckets, order.order_id, delivery, state, []);
        continue;
      }

      const request = delivery.events as EventsRequest;
      const requestIds = new Set<string>();
      const orderIds = new Set<string>();
      for (const event of request.events) {
        if (requestIds.has(event.event_id)) {
          invalid('Recovery delivery contains a duplicate event identity.');
        }
        requestIds.add(event.event_id);
        const order = ordersById.get(event.order_id);
        const journalEvent = eventsById.get(event.event_id);
        if (order === undefined) invalid('Recovery delivery references an unknown order.');
        if (
          order.runner_id !== request.runner_id
          || journalEvent === undefined
          || stableSha256(journalEvent) !== stableSha256(event)
        ) {
          invalid('Recovery delivery event does not match journal evidence.');
        }
        orderIds.add(order.order_id);
      }

      if (delivery.kind === 'plan-events' && orderIds.size !== 1) {
        invalid('Plan-bound recovery delivery mixes order identity.');
      }

      for (const orderId of orderIds) {
        const matching = request.events
          .filter((event) => event.order_id === orderId)
          .sort((left, right) => left.sequence - right.sequence);
        if (delivery.kind === 'plan-events') {
          const last = eventsByOrder.get(orderId)?.at(-1);
          if (
            matching.length !== 1
            || last === undefined
            || !TERMINAL_STATES.has(matching[0]!.state)
            || matching[0]!.event_id !== last.event_id
          ) {
            invalid('Plan-bound delivery is not the exact terminal journal result.');
          }
        }
        addDeliveryEvidence(
          deliveryBuckets,
          orderId,
          delivery,
          state,
          matching.map((event) => event.event_id),
        );
      }
    }
  };

  processDeliveries(rawPending, 'pending');
  processDeliveries(rawDelivered, 'delivered');

  const executions = [...ordersById.values()]
    .sort((left, right) => left.order_id.localeCompare(right.order_id, 'en'))
    .map((order): ExecutionRecoveryEvidence => {
      const events = [...(eventsByOrder.get(order.order_id) ?? [])]
        .sort((left, right) => left.sequence - right.sequence);
      const bucket = deliveryBuckets.get(order.order_id);
      const deliveries = Object.freeze(
        [...(bucket?.deliveries ?? [])]
          .sort((left, right) => left.delivery_id.localeCompare(right.delivery_id, 'en')),
      );
      const planFingerprint = bucket?.plan_fingerprints.values().next().value ?? null;
      const last = events.at(-1) ?? null;
      const counts = Object.freeze({
        events: events.length,
        pending_deliveries: deliveries.filter((item) => item.state === 'pending').length,
        delivered_deliveries: deliveries.filter((item) => item.state === 'delivered').length,
      });
      const core = Object.freeze({
        version: 1 as const,
        order_id: order.order_id,
        runner_id: order.runner_id,
        work_item_id: order.work_item_id,
        order_fingerprint: orderFingerprint(order),
        plan_fingerprint: planFingerprint,
        recovery: classify(events),
        last_event_id: last?.event_id ?? null,
        last_sequence: last?.sequence ?? 0,
        counts,
        deliveries,
      });
      return Object.freeze({ ...core, fingerprint: stableSha256(core) });
    });

  const counts = Object.freeze({
    orders: executions.length,
    events: rawEvents.length,
    pending_deliveries: rawPending.length,
    delivered_deliveries: rawDelivered.length,
  });
  const core = Object.freeze({
    version: 1 as const,
    counts,
    executions: Object.freeze(executions),
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
