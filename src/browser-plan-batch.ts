import type { BrowserPlanStep } from './browser-plan.ts';
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

export type BrowserPlanBatchItem = Readonly<{
  index: number;
  step: BrowserPlanStep;
}>;

export type BrowserPlanBatch = {
  version: 1;
  authority: 'unchanged';
  order_id: string;
  runner_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  capability: BrowserPlanStep['capability'];
  steps: readonly BrowserPlanBatchItem[];
  fingerprint: string;
};

type BrowserPlanBatchCore = Omit<BrowserPlanBatch, 'fingerprint'>;
type BrowserCapability = BrowserPlanStep['capability'];

const ITEM_KEYS = ['index', 'step'] as const;
const STEP_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'plan_fingerprint',
  'adapter_id',
  'capability',
  'payload',
  'fingerprint',
] as const;
const ALLOWED_CAPABILITIES = new Set<BrowserCapability>([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value: unknown, label: string): string {
  const parsed = ref(value, label, 64).toLowerCase();
  if (!SHA256_RE.test(parsed)) throw new TypeError(label + ' inválido.');
  return parsed;
}

function capability(value: unknown, label: string): BrowserCapability {
  const parsed = stringValue(value, label, 64);
  if (!ALLOWED_CAPABILITIES.has(parsed as BrowserCapability)) {
    throw new TypeError(label + ' no permitida.');
  }
  return parsed as BrowserCapability;
}

function httpsUrl(value: unknown): string {
  const raw = noSensitiveText(stringValue(value, 'payload.url', 2048), 'payload.url');
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

function normalizedPayload(
  browserCapability: BrowserCapability,
  input: unknown,
): BrowserPlanStep['payload'] {
  const payload = asRecord(input, 'BrowserPlanStep payload');

  if (browserCapability === 'browser.navigate') {
    exactKeys(payload, ['url'], 'browser.navigate payload');
    return Object.freeze({ url: httpsUrl(payload.url) });
  }

  if (browserCapability === 'browser.click_ref') {
    exactKeys(payload, ['ref'], 'browser.click_ref payload');
    return Object.freeze({ ref: ref(payload.ref, 'payload.ref', 128) });
  }

  if (browserCapability === 'browser.type_ref') {
    exactKeys(payload, ['ref', 'text'], 'browser.type_ref payload');
    return Object.freeze({
      ref: ref(payload.ref, 'payload.ref', 128),
      text: noSensitiveText(stringValue(payload.text, 'payload.text', 2000), 'payload.text'),
    });
  }

  exactKeys(payload, [], 'browser.close payload');
  return Object.freeze({});
}

function normalizedStep(input: unknown): BrowserPlanStep {
  const step = asRecord(input, 'BrowserPlanStep');
  exactKeys(step, STEP_KEYS, 'BrowserPlanStep');
  if (step.version !== 1 || step.authority !== 'unchanged') {
    throw new TypeError('BrowserPlanStep no conserva autoridad.');
  }

  const browserCapability = capability(step.capability, 'step.capability');
  const core = {
    version: 1 as const,
    authority: 'unchanged' as const,
    order_id: uuid(step.order_id, 'step.order_id'),
    runner_id: uuid(step.runner_id, 'step.runner_id'),
    plan_fingerprint: sha256(step.plan_fingerprint, 'step.plan_fingerprint'),
    adapter_id: slug(step.adapter_id, 'step.adapter_id'),
    capability: browserCapability,
    payload: normalizedPayload(browserCapability, step.payload),
  };
  const fingerprint = sha256(step.fingerprint, 'step.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('BrowserPlanStep fingerprint incoherente.');
  }

  return Object.freeze({ ...core, fingerprint });
}

export function browserPlanBatch(input: unknown): BrowserPlanBatch {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    throw new TypeError('BrowserPlanBatch debe contener entre 1 y 32 steps.');
  }

  let orderId: string | undefined;
  let runnerId: string | undefined;
  let planFingerprint: string | undefined;
  let adapterId: string | undefined;
  let batchCapability: BrowserCapability | undefined;
  const normalized: BrowserPlanBatchItem[] = [];

  input.forEach((itemInput, position) => {
    const item = asRecord(itemInput, 'BrowserPlanBatch item');
    exactKeys(item, ITEM_KEYS, 'BrowserPlanBatch item');
    const index = integer(item.index, 'batch.index', 0, 31);
    if (index !== position) {
      throw new TypeError('BrowserPlanBatch requiere índices contiguos y ordenados desde cero.');
    }

    const step = normalizedStep(item.step);
    if (orderId === undefined) {
      orderId = step.order_id;
      runnerId = step.runner_id;
      planFingerprint = step.plan_fingerprint;
      adapterId = step.adapter_id;
      batchCapability = step.capability;
    } else if (
      step.order_id !== orderId
      || step.runner_id !== runnerId
      || step.plan_fingerprint !== planFingerprint
      || step.adapter_id !== adapterId
      || step.capability !== batchCapability
    ) {
      throw new TypeError('BrowserPlanBatch mezcla orden, runner, ExecutionPlan, adapter o capability.');
    }

    normalized.push(Object.freeze({ index, step }));
  });

  if (
    orderId === undefined
    || runnerId === undefined
    || planFingerprint === undefined
    || adapterId === undefined
    || batchCapability === undefined
  ) {
    throw new TypeError('BrowserPlanBatch vacío.');
  }

  const steps = Object.freeze(normalized);
  const core: BrowserPlanBatchCore = {
    version: 1,
    authority: 'unchanged',
    order_id: orderId,
    runner_id: runnerId,
    plan_fingerprint: planFingerprint,
    adapter_id: adapterId,
    capability: batchCapability,
    steps,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
