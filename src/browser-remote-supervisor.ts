import type { BrowserCapability, BrowserLocation } from './adapters/browser.ts';
import type { AdapterRegistry } from './adapters/programmatic.ts';
import type { BrowserLoopRequest } from './browser-loop-request.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import { resolveBrowserRemoteAdapter } from './browser-remote-resolver.ts';
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
  if (!Array.isArray(dependencies.allowed_origins)) {
    throw new TypeError('allowed_origins debe ser un arreglo.');
  }

  const identity = parseRunnerIdentity(dependencies.identity);
  const location = browserLocation(identity.location);
  const loop = new ExecutionLoop({
    journal: dependencies.journal,
    registry: dependencies.registry,
    identity,
    browser_adapter_resolver: (request) => {
      if (request.runner_id !== identity.runner_id) {
        throw new TypeError('BrowserLoopRequest pertenece a otro runner.');
      }
      return resolveBrowserRemoteAdapter({
        directory: dependencies.directory,
        allowed_origins: dependencies.allowed_origins,
        context: {
          runner_id: request.runner_id,
          order_id: request.order_id,
          location,
        },
        capability: browserCapability(request),
      });
    },
    now: dependencies.now,
    event_id: dependencies.event_id,
  });

  return new RuntimeSupervisor({
    client: dependencies.client,
    journal: dependencies.journal,
    outbox: dependencies.outbox,
    loop,
    admission: dependencies.admission,
    plan: dependencies.plan,
    browser_request: dependencies.browser_request,
    now: dependencies.now,
    event_id: dependencies.event_id,
  });
}
