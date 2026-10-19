import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdapterRegistry } from '../src/adapters/programmatic.ts';
import type { ControlBotTransport } from '../src/controlbot/transport.ts';
import { DurableJournal } from '../src/journal.ts';
import { DurableOutbox } from '../src/outbox.ts';
import { runRunner } from '../src/main.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const identity = {
  version: 1, runner_id: runnerId, protocol_version: 1,
  runtime: 'node', runtime_version: '24.0.0', platform: 'linux',
  location: 'mock', capabilities: ['git'], max_parallel: 1,
};
const order = {
  version: 1, order_id: orderId, work_item_id: 'factoryrunner:work:576',
  runner_id: runnerId, capability: 'git', attempt: 1,
  issued_at: 1_000, expires_at: 2_000,
  instruction_ref: 'controlbot:instruction:factoryrunner-576',
};

test('runner e2e mock completes registration order ack and replay once', async () => {
  const seen: { path: string; payload: Record<string, unknown> }[] = [];
  const phases: string[] = [];
  let executions = 0;
  // The only network endpoint is a disposable listener bound to IPv4 loopback.
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (body.length < 1 || body.length > 8192) {
        response.writeHead(413).end();
        return;
      }
      const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const path = request.url ?? '';
      seen.push({ path, payload });
      if (path === '/v1/runner/orders/poll') {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ version: 1, cursor: null, orders: [order] }));
      } else if (path === '/v1/runner/orders/ack') {
        phases.push('ack');
        response.writeHead(204).end();
      } else if (path === '/v1/runner/events') {
        phases.push('events');
        response.writeHead(204).end();
      } else if (path === '/v1/runner/heartbeat') {
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-e2e-576-'));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    const post = async (route: string, data: unknown, hasBody = false): Promise<unknown> => {
      const reply = await fetch(origin + route, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data), redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(reply.status, hasBody ? 200 : 204);
      return hasBody ? reply.json() : undefined;
    };
    const transport: ControlBotTransport = {
      poll: (value) => post('/v1/runner/orders/poll', value, true),
      ack: async (value) => { await post('/v1/runner/orders/ack', value); },
      publishEvents: async (value) => { await post('/v1/runner/events', value); },
      publishHeartbeat: async (value) => { await post('/v1/runner/heartbeat', value); },
    };
    const registry = new AdapterRegistry([{
      id: 'synthetic', capabilities: ['git'],
      async execute(capability) {
        executions += 1;
        phases.push('execute');
        assert.equal(capability, 'git');
        return {
          capability, data: { synthetic: true },
          evidence: { code: 'done', summary: 'Mock adapter completed', ref: null },
        };
      },
    }]);
    const journalPath = join(directory, 'journal.ndjson');
    const outboxPath = join(directory, 'outbox.ndjson');
    const result = await runRunner({
      identity, transport, registry,
      journal_path: journalPath, outbox_path: outboxPath,
      cycles: 2, poll_limit: 1, now: () => 1_500,
    });
    assert.deepEqual(result, { runner_id: runnerId, ticks: 2, processed: 2, drained: true });
    assert.equal(executions, 1, 'replay must not dispatch the adapter twice');
    assert.deepEqual(phases, ['ack', 'execute', 'events']);
    assert.deepEqual(seen.map((item) => item.path), [
      '/v1/runner/heartbeat', '/v1/runner/orders/poll',
      '/v1/runner/orders/ack', '/v1/runner/events',
      '/v1/runner/orders/poll', '/v1/runner/heartbeat',
    ]);
    const heartbeats = seen.filter((item) => item.path === '/v1/runner/heartbeat')
      .map((item) => item.payload.heartbeat as { status: string; sequence: number });
    assert.deepEqual(heartbeats.map((item) => [item.status, item.sequence]), [
      ['ready', 1], ['draining', 2],
    ]);
    const ack = seen.find((item) => item.path === '/v1/runner/orders/ack')?.payload;
    assert.equal(ack?.order_id, orderId);
    assert.equal(ack?.runner_id, runnerId);
    assert.match(String(ack?.fingerprint), /^[a-f0-9]{64}$/);
    const published = seen.find((item) => item.path === '/v1/runner/events')
      ?.payload.events as { state: string }[] | undefined;
    assert.deepEqual(published?.map((event) => event.state), ['accepted', 'started', 'completed']);
    const recovered = new DurableJournal(journalPath).recover();
    assert.equal(recovered.orders.length, 1);
    assert.deepEqual(recovered.events.map((event) => event.state), ['accepted', 'started', 'completed']);
    assert.equal(new DurableOutbox(outboxPath).recover().delivered.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
