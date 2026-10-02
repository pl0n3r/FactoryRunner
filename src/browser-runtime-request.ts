import { browserLoopRequest, type BrowserLoopRequest } from './browser-loop-request.ts';
import { asRecord, exactKeys } from './validation.ts';

const RUNTIME_REQUEST_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'work_item_id',
  'plan_fingerprint',
  'adapter_id',
  'capability',
  'browser_kind',
  'browser_fingerprint',
  'browser',
  'fingerprint',
] as const;

export function resolveBrowserRuntimeRequest(
  orderInput: unknown,
  planInput: unknown,
  requestInput: unknown,
): BrowserLoopRequest {
  const provided = asRecord(requestInput, 'BrowserLoopRequest');
  exactKeys(provided, RUNTIME_REQUEST_KEYS, 'BrowserLoopRequest');

  if (provided.version !== 1 || provided.authority !== 'unchanged') {
    throw new TypeError('BrowserLoopRequest no conserva version/authority canónicas.');
  }

  const canonical = browserLoopRequest(orderInput, planInput, {
    version: provided.version,
    browser_kind: provided.browser_kind,
    browser: provided.browser,
  });

  if (
    provided.order_id !== canonical.order_id
    || provided.runner_id !== canonical.runner_id
    || provided.work_item_id !== canonical.work_item_id
    || provided.plan_fingerprint !== canonical.plan_fingerprint
    || provided.adapter_id !== canonical.adapter_id
    || provided.capability !== canonical.capability
    || provided.browser_kind !== canonical.browser_kind
    || provided.browser_fingerprint !== canonical.browser_fingerprint
    || provided.fingerprint !== canonical.fingerprint
  ) {
    throw new TypeError('BrowserLoopRequest runtime no corresponde al binding canónico.');
  }

  return canonical;
}
