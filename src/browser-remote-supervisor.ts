import type { BrowserCapability, BrowserLocation } from './adapters/browser.ts';
import type { AdapterRegistry } from './adapters/programmatic.ts';
import type { BrowserLoopRequest } from './browser-loop-request.ts';
import { browserPlacementGuard } from './browser-placement-guard.ts';
import { browserRemoteDispatchBinding } from './browser-remote-dispatch-binding.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import { browserRemoteOriginPolicy } from './browser-remote-origin-policy.ts';
import { resolvePinnedBrowserRemoteAdapter } from './browser-remote-resolver.ts';
import type { ControlBotClient } from './controlbot/client.ts';
import type { ExecutionAdmissionDecision } from './execution-admission.ts';
import { ExecutionLoop } from './execution-loop.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import type { DurableJournal } from './journal.ts';
import type { DurableOutbox } from './outbox.ts';
import type { ExecutionOrder } from './order.ts';
import { parseRunnerIdentity, type RunnerIdentity } from './runner.ts';
import {
  RuntimeSupervisor,
  type RuntimeBrowserRequestResolver,
} from './runtime-supervisor.ts';

const BROWSER_LOCATIONS = new Set<BrowserLocation>([
  'hostinger-shared',
  'macos-local',
]);

export type BrowserPlacementProfileResolver = (
  order: ExecutionOrder,
  plan: ExecutionPlan,
) => unknown;

export type BrowserRemoteSupervisorDependencies = {
  client: ControlBotClient;
  journal: DurableJournal;
  outbox: DurableOutbox;
  registry: AdapterRegistry;
  identity: RunnerIdentity;
  directory: BrowserRemoteDirectory;
  allowed_origins: readonly string[];
  admission: (
    order: ExecutionOrder,
    now: number,
  ) => ExecutionAdmissionDecision;
  plan: (
    order: ExecutionOrder,
    admission: ExecutionAdmissionDecision,
    now: number,
  ) => ExecutionPlan;
  placement_profile: BrowserPlacementProfileResolver;
  browser_request: RuntimeBrowserRequestResolver;
  now?: () => number;
  event_id?: () => string;
};

function browserLocation(value: string): BrowserLocation {
  if (!BROWSER_LOCATIONS.has(value as BrowserLocation)) {
    throw new TypeError('RunnerIdentity location no soportada para browser remoto.');
  }
  return value as BrowserLocation;
}

function browserCapability(request: BrowserLoopRequest): BrowserCapability {
  return request.capability as BrowserCapability;
}

export function createBrowserRemoteSupervisor(
  dependencies: BrowserRemoteSupervisorDependencies,
): RuntimeSupervisor {
  if (!(dependencies.directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }
  const allowedOrigins = browserRemoteOriginPolicy(dependencies.allowed_origins);

  const identity = parseRunnerIdentity(dependencies.identity);
  const location = browserLocation(identity.location);
  const directory = dependencies.directory;
  const pinnedBindings = new Map<string, string>();
  const loop = new ExecutionLoop({
    journal: dependencies.journal,
    registry: dependencies.registry,
    identity,
    browser_adapter_resolver: (request) => {
      if (request.runner_id !== identity.runner_id) {
        throw new TypeError('BrowserLoopRequest pertenece a otro runner.');
      }
      const bindingFingerprint = pinnedBindings.get(request.fingerprint);
      if (bindingFingerprint === undefined) {
        throw new TypeError('Binding browser remoto pinneado no disponible.');
      }

      try {
        return resolvePinnedBrowserRemoteAdapter({
          directory,
          allowed_origins: allowedOrigins,
          context: {
            runner_id: request.runner_id,
            order_id: request.order_id,
            location,
          },
          capability: browserCapability(request),
          binding_fingerprint: bindingFingerprint,
        });
      } finally {
        pinnedBindings.delete(request.fingerprint);
      }
    },
    now: dependencies.now,
    event_id: dependencies.event_id,
  });

  const guardedBrowserRequest: RuntimeBrowserRequestResolver = (order, plan) => {
    let placementProfile: unknown;
    let rawRequest: unknown;
    try {
      placementProfile = dependencies.placement_profile(order, plan);
      rawRequest = dependencies.browser_request(order, plan);
    } catch {
      throw new TypeError('Browser placement/request no disponible.');
    }

    const guarded = browserPlacementGuard(
      placementProfile,
      directory,
      order,
      plan,
      rawRequest,
    );
    const dispatchBinding = browserRemoteDispatchBinding(
      plan,
      guarded.request,
      guarded.evidence,
    );
    const existing = pinnedBindings.get(guarded.request.fingerprint);
    if (
      existing !== undefined
      && existing !== dispatchBinding.binding_fingerprint
    ) {
      throw new TypeError('BrowserLoopRequest cambió de binding pinneado.');
    }
    pinnedBindings.set(
      guarded.request.fingerprint,
      dispatchBinding.binding_fingerprint,
    );
    return guarded.request;
  };

  return new RuntimeSupervisor({
    client: dependencies.client,
    journal: dependencies.journal,
    outbox: dependencies.outbox,
    loop,
    admission: dependencies.admission,
    plan: dependencies.plan,
    browser_request: guardedBrowserRequest,
    now: dependencies.now,
    event_id: dependencies.event_id,
  });
}
