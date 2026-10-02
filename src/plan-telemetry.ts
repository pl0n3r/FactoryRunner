import { orderFingerprint, parseExecutionOrder } from './order.ts';
import {
  asRecord,
  capability,
  exactKeys,
  ref,
  slug,
  stableSha256,
  uuid,
} from './validation.ts';

export type PlanTelemetry = {
  version: 1;
  authority: 'unchanged';
  runner_id: string;
  order_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  fingerprint: string;
};

type PlanTelemetryCore = Omit<PlanTelemetry, 'fingerprint'>;

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

export function planTelemetry(
  orderInput: unknown,
  planInput: unknown,
  executedAdapterIdInput: unknown,
): PlanTelemetry {
  const order = parseExecutionOrder(orderInput);
  const plan = asRecord(planInput, 'ExecutionPlan');
  exactKeys(plan, PLAN_KEYS, 'ExecutionPlan');

  if (plan.version !== 1 || plan.authority !== 'unchanged') {
    throw new TypeError('ExecutionPlan no conserva autoridad.');
  }

  const runnerId = uuid(plan.runner_id, 'plan.runner_id');
  const orderId = uuid(plan.order_id, 'plan.order_id');
  const workItemId = ref(plan.work_item_id, 'plan.work_item_id', 160);
  const parsedCapability = capability(plan.capability, 'plan.capability');
  const adapterId = slug(plan.adapter_id, 'plan.adapter_id');
  const executedAdapterId = slug(executedAdapterIdInput, 'executed_adapter_id');
  const planFingerprint = sha256(plan.fingerprint, 'plan.fingerprint');

  if (
    runnerId !== order.runner_id
    || orderId !== order.order_id
    || workItemId !== order.work_item_id
    || parsedCapability !== order.capability
    || sha256(plan.order_fingerprint, 'plan.order_fingerprint') !== orderFingerprint(order)
    || adapterId !== executedAdapterId
  ) {
    throw new TypeError('ExecutionPlan no corresponde a la ejecución observada.');
  }

  sha256(plan.admission_fingerprint, 'plan.admission_fingerprint');
  sha256(plan.manifest_fingerprint, 'plan.manifest_fingerprint');
  sha256(plan.resource_fingerprint, 'plan.resource_fingerprint');

  const { fingerprint: _ignored, ...planCore } = plan;
  if (stableSha256(planCore) !== planFingerprint) {
    throw new TypeError('ExecutionPlan fingerprint incoherente.');
  }

  const core: PlanTelemetryCore = {
    version: 1,
    authority: 'unchanged',
    runner_id: runnerId,
    order_id: orderId,
    plan_fingerprint: planFingerprint,
    adapter_id: adapterId,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
