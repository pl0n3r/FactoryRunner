import { isAbsolute } from 'node:path';
import { AdapterRegistry } from '../src/adapters/programmatic.ts';
import type { ControlBotTransport } from '../src/controlbot/transport.ts';
import { runRunner } from '../src/main.ts';
import { parseRunnerIdentity } from '../src/runner.ts';

const ROUTES = {
  poll: '/v1/runner/orders/poll',
  ack: '/v1/runner/orders/ack',
  events: '/v1/runner/events',
  heartbeat: '/v1/runner/heartbeat',
} as const;

/** Exclusivamente un servidor de pruebas en loopback. Nunca un ControlBot real. */
function localMockTransport(originInput: unknown): ControlBotTransport {
  if (typeof originInput !== 'string') throw new TypeError('mock_origin_invalid');
  const origin = new URL(originInput);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || origin.username !== '' || origin.password !== ''
      || origin.pathname !== '/' || origin.search !== ''
      || origin.hash !== '' || origin.origin !== originInput) {
    throw new TypeError('mock_origin_not_loopback');
  }
  const send = async (route: string, input: unknown, readBody: boolean): Promise<unknown> => {
    const response = await fetch(origin.origin + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new TypeError('mock_transport_failed');
    return readBody ? response.json() : undefined;
  };
  return {
    poll: (input) => send(ROUTES.poll, input, true),
    ack: async (input) => { await send(ROUTES.ack, input, false); },
    publishEvents: async (input) => { await send(ROUTES.events, input, false); },
    publishHeartbeat: async (input) => { await send(ROUTES.heartbeat, input, false); },
  };
}

type MockConfig = {
  identity: unknown;
  origin: string;
  journal_path: string;
  outbox_path: string;
  cycles: number;
};

function parseConfig(input: string | undefined): MockConfig {
  if (typeof input !== 'string' || input.length > 4096) throw new TypeError('mock_config_missing');
  const record: unknown = JSON.parse(input);
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('mock_config_invalid');
  }
  const data = record as Record<string, unknown>;
  const fields = ['identity', 'origin', 'journal_path', 'outbox_path', 'cycles'];
  if (Object.keys(data).length !== fields.length || !fields.every((field) => Object.hasOwn(data, field))) {
    throw new TypeError('mock_config_keys_invalid');
  }
  if (typeof data.journal_path !== 'string' || !isAbsolute(data.journal_path)
      || typeof data.outbox_path !== 'string' || !isAbsolute(data.outbox_path)
      || typeof data.cycles !== 'number' || !Number.isInteger(data.cycles)) {
    throw new TypeError('mock_config_invalid');
  }
  return {
    identity: data.identity,
    origin: data.origin as string,
    journal_path: data.journal_path,
    outbox_path: data.outbox_path,
    cycles: data.cycles,
  };
}

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);

try {
  const config = parseConfig(process.env.FACTORYRUNNER_TEST_CONFIG);
  const identity = parseRunnerIdentity(config.identity);
  // El CLI offline no instala adapters reales ni simula su éxito.
  const registry = new AdapterRegistry([{
    id: 'unavailable',
    capabilities: identity.capabilities,
    async execute() {
      throw new TypeError('adapter_not_configured');
    },
  }]);
  const result = await runRunner({
    identity,
    registry,
    transport: localMockTransport(config.origin),
    journal_path: config.journal_path,
    outbox_path: config.outbox_path,
    cycles: config.cycles,
    signal: controller.signal,
  });
  process.stdout.write(JSON.stringify({ status: 'runner_completed', ...result }) + '\n');
} catch {
  // No imprimir config, URL, secretos, contenido de órdenes ni excepciones externas.
  process.stderr.write('runner_failed\n');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', interrupt);
  process.removeListener('SIGINT', interrupt);
}
