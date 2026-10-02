import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
  ref,
  slug,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserPlanStep = {
  version: 1;
  authority: 'unchanged';
  order_id: string;
  runner_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  capability: 'browser.navigate' | 'browser.click_ref' | 'browser.type_ref' | 'browser.close';
  payload:
    | Readonly<{ url: string }>
    | Readonly<{ ref: string }>
    | Readonly<{ ref: string; text: string }>
    | Readonly<Record<string, never>>;
  fingerprint: string;
};

type BrowserPlanStepCore = Omit<BrowserPlanStep, 'fingerprint'>;
type BrowserCapability = BrowserPlanStep['capability'];

const STEP_KEYS = ['version', 'adapter_id', 'capability', 'payload'] as const;
const ORDER_KEYS = [
  'version',
  'order_id',
  'work_item_id',
  'runner_id',
  'capability',
  'attempt',
  'issued_at',
  'expires_at',
  'instruction_ref',
] as const;
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
const ALLOWED_CAPABILITIES = new Set<BrowserCapability>([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function browserCapability(value: unknown, label: string): BrowserCapability {
  const parsed = stringValue(value, label, 64);
  if (!ALLOWED_CAPABILITIES.has(parsed as BrowserCapability)) {
    throw new TypeError(label + ' no permitida.');
  }
  return parsed as BrowserCapability;
}

function sha256(value: unknown, label: string): string {
  const parsed = ref(value, label, 64).toLowerCase();
  if (!SHA256_RE.test(parsed)) throw new TypeError(label + ' inválido.');
  return parsed;
}

function browserOrder(input: unknown): {
  order_id: string;
  runner_id: string;
  work_item_id: string;
  capability: BrowserCapability;
  fingerprint: string;
} {
  const record = asRecord(input, 'ExecutionOrder');
  exactKeys(record, ORDER_KEYS, 'ExecutionOrder');
  if (record.version !== 1) throw new TypeError('ExecutionOrder version inválida.');

  const issuedAt = integer(record.issued_at, 'issued_at');
  const expiresAt = integer(record.expires_at, 'expires_at', issuedAt + 1);
  if (expiresAt - issuedAt > 86_400) throw new TypeError('TTL de orden excesivo.');

  const instructionRef = ref(record.instruction_ref, 'instruction_ref');
  if (!instructionRef.startsWith('controlbot:')) {
    throw new TypeError('instruction_ref debe pertenecer a ControlBot.');
  }

  const normalized = {
    version: 1 as const,
    order_id: uuid(record.order_id, 'order_id'),
    work_item_id: ref(record.work_item_id, 'work_item_id', 160),
    runner_id: uuid(record.runner_id, 'runner_id'),
    capability: browserCapability(record.capability, 'capability'),
    attempt: integer(record.attempt, 'attempt', 1, 10),
    issued_at: issuedAt,
    expires_at: expiresAt,
    instruction_ref: instructionRef,
  };

  return {
    order_id: normalized.order_id,
    runner_id: normalized.runner_id,
    work_item_id: normalized.work_item_id,
    capability: normalized.capability,
    fingerprint: stableSha256(normalized),
  };
}

function browserPlanBinding(
  orderInput: unknown,
  planInput: unknown,
  adapterId: string,
  capability: BrowserCapability,
): { order_id: string; runner_id: string; plan_fingerprint: string; adapter_id: string } {
  const order = browserOrder(orderInput);
  const plan = asRecord(planInput, 'ExecutionPlan');
  exactKeys(plan, PLAN_KEYS, 'ExecutionPlan');

  if (plan.version !== 1 || plan.authority !== 'unchanged') {
    throw new TypeError('ExecutionPlan no conserva autoridad.');
  }

  const runnerId = uuid(plan.runner_id, 'plan.runner_id');
  const orderId = uuid(plan.order_id, 'plan.order_id');
  const workItemId = ref(plan.work_item_id, 'plan.work_item_id', 160);
  const planCapability = browserCapability(plan.capability, 'plan.capability');
  const planAdapter = slug(plan.adapter_id, 'plan.adapter_id');
  const planFingerprint = sha256(plan.fingerprint, 'plan.fingerprint');

  const orderHash = sha256(plan.order_fingerprint, 'plan.order_fingerprint');
  sha256(plan.admission_fingerprint, 'plan.admission_fingerprint');
  sha256(plan.manifest_fingerprint, 'plan.manifest_fingerprint');
  sha256(plan.resource_fingerprint, 'plan.resource_fingerprint');

  const { fingerprint: _ignored, ...planCore } = plan;
  if (stableSha256(planCore) !== planFingerprint) {
    throw new TypeError('ExecutionPlan fingerprint incoherente.');
  }

  if (
    runnerId !== order.runner_id
    || orderId !== order.order_id
    || workItemId !== order.work_item_id
    || planCapability !== order.capability
    || planCapability !== capability
    || planAdapter !== adapterId
    || orderHash !== order.fingerprint
  ) {
    throw new TypeError('Browser step no corresponde al ExecutionPlan ejecutado.');
  }

  return {
    order_id: orderId,
    runner_id: runnerId,
    plan_fingerprint: planFingerprint,
    adapter_id: planAdapter,
  };
}

function httpsUrl(value: unknown): string {
  const raw = stringValue(value, 'payload.url', 2048);
  noSensitiveText(raw, 'payload.url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('payload.url inválida.');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('payload.url debe ser HTTPS y no incluir credenciales.');
  }
  return parsed.toString();
}

function payloadFor(capability: BrowserCapability, input: unknown): BrowserPlanStep['payload'] {
  const payload = asRecord(input, 'browser step payload');

  if (capability === 'browser.navigate') {
    exactKeys(payload, ['url'], 'browser.navigate payload');
    return Object.freeze({ url: httpsUrl(payload.url) });
  }

  if (capability === 'browser.click_ref') {
    exactKeys(payload, ['ref'], 'browser.click_ref payload');
    return Object.freeze({ ref: ref(payload.ref, 'payload.ref', 128) });
  }

  if (capability === 'browser.type_ref') {
    exactKeys(payload, ['ref', 'text'], 'browser.type_ref payload');
    return Object.freeze({
      ref: ref(payload.ref, 'payload.ref', 128),
      text: noSensitiveText(stringValue(payload.text, 'payload.text', 2000), 'payload.text'),
    });
  }

  exactKeys(payload, [], 'browser.close payload');
  return Object.freeze({});
}

export function browserPlanStep(
  orderInput: unknown,
  planInput: unknown,
  stepInput: unknown,
): BrowserPlanStep {
  const step = asRecord(stepInput, 'BrowserPlanStepInput');
  exactKeys(step, STEP_KEYS, 'BrowserPlanStepInput');
  if (step.version !== 1) throw new TypeError('BrowserPlanStepInput version inválida.');

  const adapterId = slug(step.adapter_id, 'step.adapter_id');
  const capability = browserCapability(step.capability, 'step.capability');
  const binding = browserPlanBinding(orderInput, planInput, adapterId, capability);
  const payload = payloadFor(capability, step.payload);

  const core: BrowserPlanStepCore = {
    version: 1,
    authority: 'unchanged',
    order_id: binding.order_id,
    runner_id: binding.runner_id,
    plan_fingerprint: binding.plan_fingerprint,
    adapter_id: binding.adapter_id,
    capability,
    payload,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
