import type {
  ExecutionRecoveryEvidence,
  ExecutionRecoverySnapshot,
  RecoveryDeliveryEvidence,
} from './execution-recovery-snapshot.ts';
import { asRecord, exactKeys, integer, ref, stableSha256, uuid } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;
const ACTIONS = ['noop', 'redeliver', 'resume', 'block'] as const;

export type ExecutionRecoveryPlanAction = (typeof ACTIONS)[number];

export type ExecutionRecoveryPlanItem = Readonly<{
  version: 1;
  order_id: string;
  runner_id: string;
  snapshot_execution_fingerprint: string;
  action: ExecutionRecoveryPlanAction;
  reason: string;
  delivery_ids: readonly string[];
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

export type ExecutionRecoveryPlan = Readonly<{
  version: 1;
  authority: 'unchanged';
  snapshot_fingerprint: string;
  execution: false;
  network_access: false;
  external_mutation: false;
  counts: Readonly<Record<ExecutionRecoveryPlanAction, number>>;
  items: readonly ExecutionRecoveryPlanItem[];
  fingerprint: string;
}>;

type ParsedExecution = {
  value: ExecutionRecoveryEvidence;
  fingerprint_valid: boolean;
};

type ParsedSnapshot = {
  value: ExecutionRecoverySnapshot;
  integrity_valid: boolean;
};

type ActionDecision = {
  action: ExecutionRecoveryPlanAction;
  reason: string;
  delivery_ids: readonly string[];
};

function sha256(input: unknown, label: string): string {
  const value = ref(input, label, 64).toLowerCase();
  if (!SHA256_RE.test(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function nullableSha256(input: unknown, label: string): string | null {
  return input === null ? null : sha256(input, label);
}

function nullableUuid(input: unknown, label: string): string | null {
  return input === null ? null : uuid(input, label);
}

function readonlyArray(input: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new TypeError(`${label} inválido.`);
  }
  return input;
}

function parseDelivery(input: unknown): RecoveryDeliveryEvidence {
  const record = asRecord(input, 'RecoveryDeliveryEvidence');
  exactKeys(
    record,
    ['delivery_id', 'kind', 'state', 'fingerprint', 'plan_fingerprint', 'event_ids'],
    'RecoveryDeliveryEvidence',
  );
  if (record.kind !== 'ack' && record.kind !== 'events' && record.kind !== 'plan-events') {
    throw new TypeError('Recovery delivery kind inválido.');
  }
  if (record.state !== 'pending' && record.state !== 'delivered') {
    throw new TypeError('Recovery delivery state inválido.');
  }
  const eventIds = readonlyArray(record.event_ids, 'delivery.event_ids', 128)
    .map((eventId) => uuid(eventId, 'delivery.event_id'));
  if (new Set(eventIds).size !== eventIds.length) {
    throw new TypeError('Recovery delivery contiene event_id duplicado.');
  }
  const planFingerprint = nullableSha256(record.plan_fingerprint, 'delivery.plan_fingerprint');
  if ((record.kind === 'plan-events') !== (planFingerprint !== null)) {
    throw new TypeError('Recovery delivery plan fingerprint incoherente.');
  }
  return Object.freeze({
    delivery_id: ref(record.delivery_id, 'delivery_id', 160),
    kind: record.kind,
    state: record.state,
    fingerprint: sha256(record.fingerprint, 'delivery.fingerprint'),
    plan_fingerprint: planFingerprint,
    event_ids: Object.freeze(eventIds),
  });
}

function parseExecution(input: unknown): ParsedExecution {
  const record = asRecord(input, 'ExecutionRecoveryEvidence');
  exactKeys(record, [
    'version',
    'order_id',
    'runner_id',
    'work_item_id',
    'order_fingerprint',
    'plan_fingerprint',
    'recovery',
    'last_event_id',
    'last_sequence',
    'counts',
    'deliveries',
    'fingerprint',
  ], 'ExecutionRecoveryEvidence');
  if (record.version !== 1) throw new TypeError('ExecutionRecoveryEvidence version inválida.');
  if (record.recovery !== 'pending' && record.recovery !== 'interrupted' && record.recovery !== 'terminal') {
    throw new TypeError('Recovery classification inválida.');
  }

  const countsRecord = asRecord(record.counts, 'recovery counts');
  exactKeys(
    countsRecord,
    ['events', 'pending_deliveries', 'delivered_deliveries'],
    'recovery counts',
  );
  const counts = Object.freeze({
    events: integer(countsRecord.events, 'counts.events'),
    pending_deliveries: integer(countsRecord.pending_deliveries, 'counts.pending_deliveries'),
    delivered_deliveries: integer(countsRecord.delivered_deliveries, 'counts.delivered_deliveries'),
  });
  const deliveries = readonlyArray(record.deliveries, 'deliveries', 3)
    .map((delivery) => parseDelivery(delivery));
  const canonicalDeliveries = [...deliveries]
    .sort((left, right) => left.delivery_id.localeCompare(right.delivery_id, 'en'));
  const canonicalOrder = deliveries.every(
    (delivery, index) => delivery.delivery_id === canonicalDeliveries[index]?.delivery_id,
  );
  const countIntegrity = counts.pending_deliveries
      === deliveries.filter((delivery) => delivery.state === 'pending').length
    && counts.delivered_deliveries
      === deliveries.filter((delivery) => delivery.state === 'delivered').length;
  const lastSequence = integer(record.last_sequence, 'last_sequence');
  const lastEventId = nullableUuid(record.last_event_id, 'last_event_id');
  const eventIntegrity = counts.events === lastSequence
    && ((counts.events === 0 && lastEventId === null) || (counts.events > 0 && lastEventId !== null));
  const planFingerprint = nullableSha256(record.plan_fingerprint, 'plan_fingerprint');
  const planDeliveryFingerprints = new Set(
    deliveries
      .filter((delivery) => delivery.kind === 'plan-events')
      .map((delivery) => delivery.plan_fingerprint),
  );
  const planIntegrity = planDeliveryFingerprints.size === 0
    ? planFingerprint === null
    : planDeliveryFingerprints.size === 1 && planDeliveryFingerprints.has(planFingerprint);

  const core = Object.freeze({
    version: 1 as const,
    order_id: uuid(record.order_id, 'order_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    work_item_id: ref(record.work_item_id, 'work_item_id', 160),
    order_fingerprint: sha256(record.order_fingerprint, 'order_fingerprint'),
    plan_fingerprint: planFingerprint,
    recovery: record.recovery,
    last_event_id: lastEventId,
    last_sequence: lastSequence,
    counts,
    deliveries: Object.freeze(deliveries),
  });
  const fingerprint = sha256(record.fingerprint, 'execution.fingerprint');
  const fingerprintValid = stableSha256(core) === fingerprint;
  return {
    value: Object.freeze({ ...core, fingerprint }),
    fingerprint_valid: fingerprintValid
      && canonicalOrder
      && countIntegrity
      && eventIntegrity
      && planIntegrity,
  };
}

function parseSnapshot(input: unknown): ParsedSnapshot {
  const record = asRecord(input, 'ExecutionRecoverySnapshot');
  exactKeys(record, ['version', 'counts', 'executions', 'fingerprint'], 'ExecutionRecoverySnapshot');
  if (record.version !== 1) throw new TypeError('ExecutionRecoverySnapshot version inválida.');
  const countsRecord = asRecord(record.counts, 'snapshot counts');
  exactKeys(
    countsRecord,
    ['orders', 'events', 'pending_deliveries', 'delivered_deliveries'],
    'snapshot counts',
  );
  const counts = Object.freeze({
    orders: integer(countsRecord.orders, 'snapshot.counts.orders'),
    events: integer(countsRecord.events, 'snapshot.counts.events'),
    pending_deliveries: integer(countsRecord.pending_deliveries, 'snapshot.counts.pending_deliveries'),
    delivered_deliveries: integer(countsRecord.delivered_deliveries, 'snapshot.counts.delivered_deliveries'),
  });
  const parsedExecutions = readonlyArray(record.executions, 'executions', 1_024)
    .map((execution) => parseExecution(execution));
  const executions = parsedExecutions.map(({ value }) => value);
  const sorted = [...executions]
    .sort((left, right) => left.order_id.localeCompare(right.order_id, 'en'));
  const canonicalOrder = executions.every(
    (execution, index) => execution.order_id === sorted[index]?.order_id,
  );
  const uniqueOrders = new Set(executions.map((execution) => execution.order_id)).size === executions.length;
  const totalsMatch = counts.orders === executions.length
    && counts.events === executions.reduce((sum, execution) => sum + execution.counts.events, 0)
    && counts.pending_deliveries === executions.reduce(
      (sum, execution) => sum + execution.counts.pending_deliveries,
      0,
    )
    && counts.delivered_deliveries === executions.reduce(
      (sum, execution) => sum + execution.counts.delivered_deliveries,
      0,
    );
  const fingerprint = sha256(record.fingerprint, 'snapshot.fingerprint');
  const core = Object.freeze({
    version: 1 as const,
    counts,
    executions: Object.freeze(executions),
  });
  const integrityValid = canonicalOrder
    && uniqueOrders
    && totalsMatch
    && parsedExecutions.every((execution) => execution.fingerprint_valid)
    && stableSha256(core) === fingerprint;
  return {
    value: Object.freeze({ ...core, fingerprint }),
    integrity_valid: integrityValid,
  };
}

function decide(execution: ExecutionRecoveryEvidence, snapshotValid: boolean): ActionDecision {
  if (!snapshotValid) {
    return { action: 'block', reason: 'snapshot-integrity-invalid', delivery_ids: [] };
  }

  const ack = execution.deliveries.find((delivery) => delivery.kind === 'ack') ?? null;
  const resultDeliveries = execution.deliveries.filter((delivery) => delivery.kind !== 'ack');
  const pending = execution.deliveries.filter((delivery) => delivery.state === 'pending');

  if (execution.recovery === 'terminal') {
    if (ack?.state !== 'delivered' || resultDeliveries.length !== 1) {
      return { action: 'block', reason: 'terminal-delivery-evidence-incomplete', delivery_ids: [] };
    }
    const result = resultDeliveries[0]!;
    if (result.state === 'pending') {
      return { action: 'redeliver', reason: 'terminal-result-pending', delivery_ids: [result.delivery_id] };
    }
    return { action: 'noop', reason: 'terminal-result-delivered', delivery_ids: [] };
  }

  if (resultDeliveries.length > 0) {
    return { action: 'block', reason: 'nonterminal-result-delivery-conflict', delivery_ids: [] };
  }
  if (execution.recovery === 'interrupted' && ack?.state !== 'delivered') {
    return { action: 'block', reason: 'interrupted-ack-evidence-incomplete', delivery_ids: [] };
  }
  if (pending.length > 0) {
    return {
      action: 'redeliver',
      reason: 'outbox-delivery-pending',
      delivery_ids: Object.freeze(pending.map((delivery) => delivery.delivery_id)),
    };
  }
  return {
    action: 'resume',
    reason: execution.recovery === 'interrupted' ? 'execution-interrupted' : 'execution-pending',
    delivery_ids: [],
  };
}

function planItem(
  execution: ExecutionRecoveryEvidence,
  snapshotValid: boolean,
): ExecutionRecoveryPlanItem {
  const decision = decide(execution, snapshotValid);
  const core = Object.freeze({
    version: 1 as const,
    order_id: execution.order_id,
    runner_id: execution.runner_id,
    snapshot_execution_fingerprint: execution.fingerprint,
    action: decision.action,
    reason: decision.reason,
    delivery_ids: Object.freeze([...decision.delivery_ids]),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionRecoveryPlan(snapshotInput: unknown): ExecutionRecoveryPlan {
  const snapshot = parseSnapshot(snapshotInput);
  const items = Object.freeze(
    snapshot.value.executions.map((execution) => planItem(execution, snapshot.integrity_valid)),
  );
  const counts = Object.freeze({
    noop: items.filter((item) => item.action === 'noop').length,
    redeliver: items.filter((item) => item.action === 'redeliver').length,
    resume: items.filter((item) => item.action === 'resume').length,
    block: items.filter((item) => item.action === 'block').length,
  });
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    snapshot_fingerprint: snapshot.value.fingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
    counts,
    items,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
