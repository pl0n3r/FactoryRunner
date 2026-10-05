import type { ExecutionRecoverySnapshot } from './execution-recovery-snapshot.ts';
import type {
  ExecutionRecoveryPlan,
  ExecutionRecoveryPlanAction,
  ExecutionRecoveryPlanItem,
} from './execution-recovery-plan.ts';
import { executionRecoveryPlan } from './execution-recovery-plan.ts';
import { asRecord, exactKeys, integer, noSensitiveText, ref, stableSha256, uuid } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;
const ACTIONS = ['noop', 'redeliver', 'resume', 'block'] as const;
const MAX_ITEMS = 1_024;
const MAX_DELIVERIES_PER_ITEM = 3;

export type ExecutionRecoveryReadinessReason =
  | 'ready'
  | 'snapshot_invalid'
  | 'plan_invalid'
  | 'snapshot_plan_mismatch'
  | 'plan_not_canonical'
  | 'blocked';

export type ExecutionRecoveryReadiness = Readonly<{
  version: 1;
  authority: 'unchanged';
  ready: boolean;
  reason: ExecutionRecoveryReadinessReason;
  snapshot_fingerprint: string | null;
  plan_fingerprint: string | null;
  execution: false;
  network_access: false;
  external_mutation: false;
  counts: Readonly<{
    orders: number;
    noop: number;
    redeliver: number;
    resume: number;
    block: number;
  }>;
  fingerprint: string;
}>;

type ParsedSnapshot = {
  value: ExecutionRecoverySnapshot;
  integrity_valid: boolean;
};

type ParsedPlan = {
  value: ExecutionRecoveryPlan;
  integrity_valid: boolean;
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

function boundedArray(input: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new TypeError(`${label} inválido.`);
  }
  return input;
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
    orders: integer(countsRecord.orders, 'snapshot.counts.orders', 0, MAX_ITEMS),
    events: integer(countsRecord.events, 'snapshot.counts.events', 0, 8_192),
    pending_deliveries: integer(
      countsRecord.pending_deliveries,
      'snapshot.counts.pending_deliveries',
      0,
      4_096,
    ),
    delivered_deliveries: integer(
      countsRecord.delivered_deliveries,
      'snapshot.counts.delivered_deliveries',
      0,
      4_096,
    ),
  });

  const rawExecutions = boundedArray(record.executions, 'snapshot.executions', MAX_ITEMS);
  const executions = rawExecutions.map((inputExecution) => {
    const execution = asRecord(inputExecution, 'ExecutionRecoveryEvidence');
    exactKeys(execution, [
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
    if (execution.version !== 1) throw new TypeError('ExecutionRecoveryEvidence version inválida.');
    if (
      execution.recovery !== 'pending'
      && execution.recovery !== 'interrupted'
      && execution.recovery !== 'terminal'
    ) {
      throw new TypeError('Recovery classification inválida.');
    }

    const executionCountsRecord = asRecord(execution.counts, 'execution counts');
    exactKeys(
      executionCountsRecord,
      ['events', 'pending_deliveries', 'delivered_deliveries'],
      'execution counts',
    );
    const executionCounts = Object.freeze({
      events: integer(executionCountsRecord.events, 'execution.counts.events', 0, 8_192),
      pending_deliveries: integer(
        executionCountsRecord.pending_deliveries,
        'execution.counts.pending_deliveries',
        0,
        MAX_DELIVERIES_PER_ITEM,
      ),
      delivered_deliveries: integer(
        executionCountsRecord.delivered_deliveries,
        'execution.counts.delivered_deliveries',
        0,
        MAX_DELIVERIES_PER_ITEM,
      ),
    });

    const rawDeliveries = boundedArray(
      execution.deliveries,
      'execution.deliveries',
      MAX_DELIVERIES_PER_ITEM,
    );
    const deliveries = rawDeliveries.map((inputDelivery) => {
      const delivery = asRecord(inputDelivery, 'RecoveryDeliveryEvidence');
      exactKeys(
        delivery,
        ['delivery_id', 'kind', 'state', 'fingerprint', 'plan_fingerprint', 'event_ids'],
        'RecoveryDeliveryEvidence',
      );
      if (delivery.kind !== 'ack' && delivery.kind !== 'events' && delivery.kind !== 'plan-events') {
        throw new TypeError('RecoveryDeliveryEvidence.kind inválido.');
      }
      if (delivery.state !== 'pending' && delivery.state !== 'delivered') {
        throw new TypeError('RecoveryDeliveryEvidence.state inválido.');
      }
      const eventIds = boundedArray(delivery.event_ids, 'delivery.event_ids', 128)
        .map((eventId) => uuid(eventId, 'delivery.event_id'));
      if (new Set(eventIds).size !== eventIds.length) {
        throw new TypeError('RecoveryDeliveryEvidence event_ids duplicados.');
      }
      const planFingerprint = nullableSha256(
        delivery.plan_fingerprint,
        'delivery.plan_fingerprint',
      );
      if ((delivery.kind === 'plan-events') !== (planFingerprint !== null)) {
        throw new TypeError('RecoveryDeliveryEvidence plan_fingerprint incoherente.');
      }
      return Object.freeze({
        delivery_id: ref(delivery.delivery_id, 'delivery_id', 160),
        kind: delivery.kind,
        state: delivery.state,
        fingerprint: sha256(delivery.fingerprint, 'delivery.fingerprint'),
        plan_fingerprint: planFingerprint,
        event_ids: Object.freeze(eventIds),
      });
    });

    const core = Object.freeze({
      version: 1 as const,
      order_id: uuid(execution.order_id, 'execution.order_id'),
      runner_id: uuid(execution.runner_id, 'execution.runner_id'),
      work_item_id: ref(execution.work_item_id, 'execution.work_item_id', 160),
      order_fingerprint: sha256(execution.order_fingerprint, 'execution.order_fingerprint'),
      plan_fingerprint: nullableSha256(
        execution.plan_fingerprint,
        'execution.plan_fingerprint',
      ),
      recovery: execution.recovery,
      last_event_id: nullableUuid(execution.last_event_id, 'execution.last_event_id'),
      last_sequence: integer(execution.last_sequence, 'execution.last_sequence', 0, 8_192),
      counts: executionCounts,
      deliveries: Object.freeze(deliveries),
    });
    const fingerprint = sha256(execution.fingerprint, 'execution.fingerprint');
    const canonicalDeliveries = [...deliveries]
      .sort((left, right) => left.delivery_id.localeCompare(right.delivery_id, 'en'));
    const deliveryOrderValid = deliveries.every(
      (delivery, index) => delivery.delivery_id === canonicalDeliveries[index]?.delivery_id,
    );
    const deliveryCountsValid = executionCounts.pending_deliveries
        === deliveries.filter((delivery) => delivery.state === 'pending').length
      && executionCounts.delivered_deliveries
        === deliveries.filter((delivery) => delivery.state === 'delivered').length;
    const eventShapeValid = executionCounts.events === core.last_sequence
      && (
        (executionCounts.events === 0 && core.last_event_id === null)
        || (executionCounts.events > 0 && core.last_event_id !== null)
      );
    const planFingerprints = new Set(
      deliveries
        .filter((delivery) => delivery.kind === 'plan-events')
        .map((delivery) => delivery.plan_fingerprint),
    );
    const planBindingValid = planFingerprints.size === 0
      ? core.plan_fingerprint === null
      : planFingerprints.size === 1 && planFingerprints.has(core.plan_fingerprint);

    return {
      value: Object.freeze({ ...core, fingerprint }),
      integrity_valid: stableSha256(core) === fingerprint
        && deliveryOrderValid
        && deliveryCountsValid
        && eventShapeValid
        && planBindingValid,
    };
  });

  const values = executions.map(({ value }) => value);
  const canonical = [...values].sort(
    (left, right) => left.order_id.localeCompare(right.order_id, 'en'),
  );
  const canonicalOrder = values.every(
    (execution, index) => execution.order_id === canonical[index]?.order_id,
  );
  const uniqueOrders = new Set(values.map((execution) => execution.order_id)).size === values.length;
  const totalsValid = counts.orders === values.length
    && counts.events === values.reduce((sum, execution) => sum + execution.counts.events, 0)
    && counts.pending_deliveries === values.reduce(
      (sum, execution) => sum + execution.counts.pending_deliveries,
      0,
    )
    && counts.delivered_deliveries === values.reduce(
      (sum, execution) => sum + execution.counts.delivered_deliveries,
      0,
    );
  const core = Object.freeze({
    version: 1 as const,
    counts,
    executions: Object.freeze(values),
  });
  const fingerprint = sha256(record.fingerprint, 'snapshot.fingerprint');
  return {
    value: Object.freeze({ ...core, fingerprint }),
    integrity_valid: stableSha256(core) === fingerprint
      && canonicalOrder
      && uniqueOrders
      && totalsValid
      && executions.every((execution) => execution.integrity_valid),
  };
}

function parsePlan(input: unknown): ParsedPlan {
  const record = asRecord(input, 'ExecutionRecoveryPlan');
  exactKeys(record, [
    'version',
    'authority',
    'snapshot_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'counts',
    'items',
    'fingerprint',
  ], 'ExecutionRecoveryPlan');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryPlan authority inválida.');
  }

  const countsRecord = asRecord(record.counts, 'plan counts');
  exactKeys(countsRecord, ACTIONS, 'plan counts');
  const counts = Object.freeze({
    noop: integer(countsRecord.noop, 'plan.counts.noop', 0, MAX_ITEMS),
    redeliver: integer(countsRecord.redeliver, 'plan.counts.redeliver', 0, MAX_ITEMS),
    resume: integer(countsRecord.resume, 'plan.counts.resume', 0, MAX_ITEMS),
    block: integer(countsRecord.block, 'plan.counts.block', 0, MAX_ITEMS),
  });

  const rawItems = boundedArray(record.items, 'plan.items', MAX_ITEMS);
  const parsedItems = rawItems.map((inputItem) => {
    const item = asRecord(inputItem, 'ExecutionRecoveryPlanItem');
    exactKeys(item, [
      'version',
      'order_id',
      'runner_id',
      'snapshot_execution_fingerprint',
      'action',
      'reason',
      'delivery_ids',
      'execution',
      'network_access',
      'external_mutation',
      'fingerprint',
    ], 'ExecutionRecoveryPlanItem');
    if (
      item.version !== 1
      || !ACTIONS.includes(item.action as ExecutionRecoveryPlanAction)
      || item.execution !== false
      || item.network_access !== false
      || item.external_mutation !== false
    ) {
      throw new TypeError('ExecutionRecoveryPlanItem inválido.');
    }
    const deliveryIds = boundedArray(
      item.delivery_ids,
      'plan.item.delivery_ids',
      MAX_DELIVERIES_PER_ITEM,
    ).map((deliveryId) => ref(deliveryId, 'plan.item.delivery_id', 160));
    if (new Set(deliveryIds).size !== deliveryIds.length) {
      throw new TypeError('ExecutionRecoveryPlanItem delivery_ids duplicados.');
    }
    const core = Object.freeze({
      version: 1 as const,
      order_id: uuid(item.order_id, 'plan.item.order_id'),
      runner_id: uuid(item.runner_id, 'plan.item.runner_id'),
      snapshot_execution_fingerprint: sha256(
        item.snapshot_execution_fingerprint,
        'plan.item.snapshot_execution_fingerprint',
      ),
      action: item.action as ExecutionRecoveryPlanAction,
      reason: noSensitiveText(
        ref(item.reason, 'plan.item.reason', 160),
        'plan.item.reason',
      ),
      delivery_ids: Object.freeze(deliveryIds),
      execution: false as const,
      network_access: false as const,
      external_mutation: false as const,
    });
    const fingerprint = sha256(item.fingerprint, 'plan.item.fingerprint');
    return {
      value: Object.freeze({ ...core, fingerprint }) as ExecutionRecoveryPlanItem,
      integrity_valid: stableSha256(core) === fingerprint,
    };
  });

  const items = parsedItems.map(({ value }) => value);
  const canonical = [...items].sort(
    (left, right) => left.order_id.localeCompare(right.order_id, 'en'),
  );
  const canonicalOrder = items.every(
    (item, index) => item.order_id === canonical[index]?.order_id,
  );
  const uniqueOrders = new Set(items.map((item) => item.order_id)).size === items.length;
  const countsValid = counts.noop === items.filter((item) => item.action === 'noop').length
    && counts.redeliver === items.filter((item) => item.action === 'redeliver').length
    && counts.resume === items.filter((item) => item.action === 'resume').length
    && counts.block === items.filter((item) => item.action === 'block').length;
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    snapshot_fingerprint: sha256(record.snapshot_fingerprint, 'plan.snapshot_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
    counts,
    items: Object.freeze(items),
  });
  const fingerprint = sha256(record.fingerprint, 'plan.fingerprint');
  return {
    value: Object.freeze({ ...core, fingerprint }),
    integrity_valid: stableSha256(core) === fingerprint
      && canonicalOrder
      && uniqueOrders
      && countsValid
      && parsedItems.every((item) => item.integrity_valid),
  };
}

function countsFor(
  snapshot: ParsedSnapshot | null,
  plan: ParsedPlan | null,
): ExecutionRecoveryReadiness['counts'] {
  return Object.freeze({
    orders: snapshot?.value.counts.orders ?? 0,
    noop: plan?.value.counts.noop ?? 0,
    redeliver: plan?.value.counts.redeliver ?? 0,
    resume: plan?.value.counts.resume ?? 0,
    block: plan?.value.counts.block ?? 0,
  });
}

function result(
  ready: boolean,
  reason: ExecutionRecoveryReadinessReason,
  snapshot: ParsedSnapshot | null,
  plan: ParsedPlan | null,
): ExecutionRecoveryReadiness {
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    ready,
    reason,
    snapshot_fingerprint: snapshot?.value.fingerprint ?? null,
    plan_fingerprint: plan?.value.fingerprint ?? null,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
    counts: countsFor(snapshot, plan),
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionRecoveryReadiness(
  snapshotInput: unknown,
  planInput: unknown,
): ExecutionRecoveryReadiness {
  let snapshot: ParsedSnapshot | null = null;
  let plan: ParsedPlan | null = null;

  try {
    snapshot = parseSnapshot(snapshotInput);
  } catch {
    return result(false, 'snapshot_invalid', null, null);
  }
  if (!snapshot.integrity_valid) {
    return result(false, 'snapshot_invalid', snapshot, null);
  }

  try {
    plan = parsePlan(planInput);
  } catch {
    return result(false, 'plan_invalid', snapshot, null);
  }
  if (!plan.integrity_valid) {
    return result(false, 'plan_invalid', snapshot, plan);
  }
  if (plan.value.snapshot_fingerprint !== snapshot.value.fingerprint) {
    return result(false, 'snapshot_plan_mismatch', snapshot, plan);
  }

  let canonical: ExecutionRecoveryPlan;
  try {
    canonical = executionRecoveryPlan(snapshot.value);
  } catch {
    return result(false, 'snapshot_invalid', snapshot, plan);
  }
  if (canonical.fingerprint !== plan.value.fingerprint) {
    return result(false, 'plan_not_canonical', snapshot, plan);
  }
  if (plan.value.counts.block > 0) {
    return result(false, 'blocked', snapshot, plan);
  }

  return result(true, 'ready', snapshot, plan);
}
