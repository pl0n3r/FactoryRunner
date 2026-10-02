import { planTelemetry } from './plan-telemetry.ts';
import {
  asRecord,
  exactKeys,
  noSensitiveText,
  ref,
  slug,
  stableSha256,
  stringValue,
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

const STEP_KEYS = ['version', 'adapter_id', 'capability', 'payload'] as const;
const ALLOWED_CAPABILITIES = new Set([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);

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

function payloadFor(capability: BrowserPlanStep['capability'], input: unknown): BrowserPlanStep['payload'] {
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
  const capability = slug(step.capability, 'step.capability');
  if (!ALLOWED_CAPABILITIES.has(capability)) {
    throw new TypeError('Capability browser no permitida.');
  }

  const telemetry = planTelemetry(orderInput, planInput, adapterId);
  if (telemetry.adapter_id !== adapterId) {
    throw new TypeError('Adapter browser no corresponde al ExecutionPlan.');
  }

  const plan = asRecord(planInput, 'ExecutionPlan');
  if (plan.capability !== capability) {
    throw new TypeError('Capability browser no corresponde al ExecutionPlan.');
  }

  const normalizedCapability = capability as BrowserPlanStep['capability'];
  const payload = payloadFor(normalizedCapability, step.payload);

  const core: BrowserPlanStepCore = {
    version: 1,
    authority: 'unchanged',
    order_id: telemetry.order_id,
    runner_id: telemetry.runner_id,
    plan_fingerprint: telemetry.plan_fingerprint,
    adapter_id: telemetry.adapter_id,
    capability: normalizedCapability,
    payload,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
