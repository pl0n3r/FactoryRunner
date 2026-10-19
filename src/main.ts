import { isAbsolute } from 'node:path';
import { AdapterRegistry } from './adapters/programmatic.ts';
import { ControlBotClient } from './controlbot/client.ts';
import type { ControlBotTransport } from './controlbot/transport.ts';
import { ExecutionLoop } from './execution-loop.ts';
import { DurableJournal } from './journal.ts';
import { DurableOutbox } from './outbox.ts';
import { parseRunnerIdentity, type RunnerIdentity } from './runner.ts';
import { RuntimeSupervisor } from './runtime-supervisor.ts';
import { integer } from './validation.ts';

export type RunnerEntrypointOptions = {
  identity: unknown;
  transport: ControlBotTransport;
  registry: AdapterRegistry;
  journal_path: string;
  outbox_path: string;
  cycles?: number;
  poll_limit?: number;
  now?: () => number;
  signal?: AbortSignal;
};

export type RunnerEntrypointResult = {
  runner_id: string;
  ticks: number;
  processed: number;
  drained: true;
};

/**
 * Inicio de ejecución offline con dependencias explícitas.
 * No configura proveedores, redes ni credenciales y no toma decisiones de go-live.
 * Un transport/adapter sólo se instala desde el llamador de confianza.
 */
export async function runRunner(options: RunnerEntrypointOptions): Promise<RunnerEntrypointResult> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('runner_config_invalid');
  }
  const identity: RunnerIdentity = parseRunnerIdentity(options.identity);
  if (!(options.registry instanceof AdapterRegistry)
      || options.transport === null
      || typeof options.transport !== 'object') {
    throw new TypeError('runner_dependencies_invalid');
  }
  if (typeof options.journal_path !== 'string'
      || typeof options.outbox_path !== 'string'
      || !isAbsolute(options.journal_path)
      || !isAbsolute(options.outbox_path)
      || options.journal_path === options.outbox_path) {
    throw new TypeError('runner_state_paths_invalid');
  }
  const cycles = integer(options.cycles ?? 1, 'cycles', 1, 32);
  const pollLimit = integer(options.poll_limit ?? 16, 'poll_limit', 1, 64);
  const client = new ControlBotClient(identity, options.transport);
  const journal = new DurableJournal(options.journal_path);
  const outbox = new DurableOutbox(options.outbox_path);
  const loop = new ExecutionLoop({
    journal,
    registry: options.registry,
    identity,
    now: options.now,
  });
  const supervisor = new RuntimeSupervisor({
    client,
    journal,
    outbox,
    loop,
    now: options.now,
  });
  let ticks = 0;
  let processed = 0;
  try {
    if (!options.signal?.aborted) {
      await supervisor.publishHeartbeat(identity, 1);
    }
    for (let i = 0; i < cycles && !options.signal?.aborted; i += 1) {
      const result = await supervisor.tick(pollLimit);
      ticks += 1;
      processed += result.processed;
    }
  } finally {
    supervisor.beginDrain();
    await supervisor.publishHeartbeat(identity, 2);
  }
  return { runner_id: identity.runner_id, ticks, processed, drained: true };
}
