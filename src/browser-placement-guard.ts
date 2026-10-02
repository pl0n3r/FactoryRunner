import type { BrowserLoopRequest } from './browser-loop-request.ts';
import { browserPlacementPolicy } from './browser-placement-policy.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import { resolveBrowserRuntimeRequest } from './browser-runtime-request.ts';
import { orderFingerprint, parseExecutionOrder } from './order.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import { stableSha256 } from './validation.ts';

export type BrowserPlacementGuardEvidence = Readonly<{
  version: 1;
  authority: 'unchanged';
  order_fingerprint: string;
  plan_fingerprint: string;
  request_fingerprint: string;
  placement_fingerprint: string;
  binding_fingerprint: string;
  fingerprint: string;
}>;

export type BrowserPlacementGuardResult = Readonly<{
  request: BrowserLoopRequest;
  evidence: BrowserPlacementGuardEvidence;
}>;

export function browserPlacementGuard(
  placementProfileInput: unknown,
  directory: BrowserRemoteDirectory,
  orderInput: unknown,
  planInput: ExecutionPlan,
  requestInput: unknown,
): BrowserPlacementGuardResult {
  if (!(directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  const order = parseExecutionOrder(orderInput);
  const request = resolveBrowserRuntimeRequest(order, planInput, requestInput);
  const bindings = directory.entries().map((entry) => entry.profile);
  const placement = browserPlacementPolicy(placementProfileInput, bindings);

  if (
    placement.placement !== 'REMOTE_BINDING'
    || placement.reason !== 'EXACT_REMOTE_BINDING'
    || placement.binding_fingerprint === null
    || placement.runner_id !== order.runner_id
  ) {
    throw new TypeError('Placement browser remoto no permitido.');
  }

  const matches = bindings.filter(
    (binding) => binding.fingerprint === placement.binding_fingerprint,
  );
  if (
    matches.length !== 1
    || matches[0].runner_id !== request.runner_id
    || matches[0].capability !== request.capability
  ) {
    throw new TypeError('Binding browser remoto no corresponde al request.');
  }

  const core = {
    version: 1 as const,
    authority: 'unchanged' as const,
    order_fingerprint: orderFingerprint(order),
    plan_fingerprint: request.plan_fingerprint,
    request_fingerprint: request.fingerprint,
    placement_fingerprint: placement.fingerprint,
    binding_fingerprint: matches[0].fingerprint,
  };
  const evidence = Object.freeze({ ...core, fingerprint: stableSha256(core) });
  return Object.freeze({ request, evidence });
}
