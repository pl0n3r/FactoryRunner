import { browserPlanBatch, type BrowserPlanBatch } from './browser-plan-batch.ts';
import { browserPlanStep, type BrowserPlanStep } from './browser-plan.ts';
import { parseExecutionOrder } from './order.ts';
import {
  asRecord,
  exactKeys,
  stableSha256,
  stringValue,
} from './validation.ts';

export type BrowserLoopRequest = {
  version: 1;
  authority: 'unchanged';
  order_id: string;
  runner_id: string;
  work_item_id: string;
  plan_fingerprint: string;
  adapter_id: string;
  capability: BrowserPlanStep['capability'];
  browser_kind: 'step' | 'batch';
  browser_fingerprint: string;
  browser: BrowserPlanStep | BrowserPlanBatch;
  fingerprint: string;
};

type BrowserLoopRequestCore = Omit<BrowserLoopRequest, 'fingerprint'>;

const REQUEST_KEYS = ['version', 'browser_kind', 'browser'] as const;
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
const BATCH_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'plan_fingerprint',
  'adapter_id',
  'capability',
  'steps',
  'fingerprint',
] as const;
const ITEM_KEYS = ['index', 'step'] as const;

function sameStep(providedInput: unknown, canonical: BrowserPlanStep): BrowserPlanStep {
  const provided = asRecord(providedInput, 'BrowserPlanStep');
  exactKeys(provided, STEP_KEYS, 'BrowserPlanStep');

  if (
    provided.version !== canonical.version
    || provided.authority !== canonical.authority
    || provided.order_id !== canonical.order_id
    || provided.runner_id !== canonical.runner_id
    || provided.plan_fingerprint !== canonical.plan_fingerprint
    || provided.adapter_id !== canonical.adapter_id
    || provided.capability !== canonical.capability
    || provided.fingerprint !== canonical.fingerprint
    || stableSha256(provided.payload) !== stableSha256(canonical.payload)
  ) {
    throw new TypeError('BrowserPlanStep no corresponde al binding canónico.');
  }

  return canonical;
}

function canonicalStep(
  orderInput: unknown,
  planInput: unknown,
  input: unknown,
): BrowserPlanStep {
  const step = asRecord(input, 'BrowserPlanStep');
  exactKeys(step, STEP_KEYS, 'BrowserPlanStep');

  const canonical = browserPlanStep(orderInput, planInput, {
    version: step.version,
    adapter_id: step.adapter_id,
    capability: step.capability,
    payload: step.payload,
  });

  return sameStep(step, canonical);
}

function canonicalBatch(
  orderInput: unknown,
  planInput: unknown,
  input: unknown,
): BrowserPlanBatch {
  const batch = asRecord(input, 'BrowserPlanBatch');
  exactKeys(batch, BATCH_KEYS, 'BrowserPlanBatch');
  if (!Array.isArray(batch.steps)) {
    throw new TypeError('BrowserPlanBatch steps inválidos.');
  }

  const items = batch.steps.map((itemInput) => {
    const item = asRecord(itemInput, 'BrowserPlanBatch item');
    exactKeys(item, ITEM_KEYS, 'BrowserPlanBatch item');
    return Object.freeze({
      index: item.index,
      step: canonicalStep(orderInput, planInput, item.step),
    });
  });

  const canonical = browserPlanBatch(items);

  if (
    batch.version !== canonical.version
    || batch.authority !== canonical.authority
    || batch.order_id !== canonical.order_id
    || batch.runner_id !== canonical.runner_id
    || batch.plan_fingerprint !== canonical.plan_fingerprint
    || batch.adapter_id !== canonical.adapter_id
    || batch.capability !== canonical.capability
    || batch.fingerprint !== canonical.fingerprint
  ) {
    throw new TypeError('BrowserPlanBatch no corresponde al binding canónico.');
  }

  return canonical;
}

export function browserLoopRequest(
  orderInput: unknown,
  planInput: unknown,
  requestInput: unknown,
): BrowserLoopRequest {
  const request = asRecord(requestInput, 'BrowserLoopRequestInput');
  exactKeys(request, REQUEST_KEYS, 'BrowserLoopRequestInput');
  if (request.version !== 1) {
    throw new TypeError('BrowserLoopRequestInput version inválida.');
  }

  const browserKind = stringValue(request.browser_kind, 'browser_kind', 16);
  if (browserKind !== 'step' && browserKind !== 'batch') {
    throw new TypeError('browser_kind inválido.');
  }

  const order = parseExecutionOrder(orderInput);
  const browser = browserKind === 'step'
    ? canonicalStep(orderInput, planInput, request.browser)
    : canonicalBatch(orderInput, planInput, request.browser);

  const core: BrowserLoopRequestCore = {
    version: 1,
    authority: 'unchanged',
    order_id: order.order_id,
    runner_id: order.runner_id,
    work_item_id: order.work_item_id,
    plan_fingerprint: browser.plan_fingerprint,
    adapter_id: browser.adapter_id,
    capability: browser.capability,
    browser_kind: browserKind,
    browser_fingerprint: browser.fingerprint,
    browser,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
