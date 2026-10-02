import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdapterRegistry, type ProgrammaticAdapter } from '../src/adapters/programmatic.ts';
import { ControlBotClient } from '../src/controlbot/client.ts';
import type { ControlBotTransport } from '../src/controlbot/transport.ts';
import { ExecutionLoop } from '../src/execution-loop.ts';
import { DurableJournal } from '../src/journal.ts';
import { DurableOutbox } from '../src/outbox.ts';
import { RuntimeSupervisor } from '../src/runtime-supervisor.ts';
import type { RunnerIdentity } from '../src/runner.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const identity: RunnerIdentity = {
  version: 1,
  runner_id: runnerId,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '24.0.0',
  platform: 'linux',
  location: 'hostinger',
  capabilities: ['git'],
  max_parallel: 1,
};
const order = {
  version: 1,
  order_id: orderId,
  work_item_id: 'factoryrunner:work:58',
  runner_id: runnerId,
  capability: 'git',
  attempt: 1,
  issued_at: 1_000,
  expires_at: 2_000,
  instruction_ref: 'controlbot:instruction:factoryrunner-58',
};

function withRuntime(run: (journal: DurableJournal, outbox: DurableOutbox) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-supervisor-'));
  return run(
    new DurableJournal(join(directory, 'journal.ndjson')),
    new DurableOutbox(join(directory, 'outbox.ndjson')),
  ).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function buildRuntime(
  journal: DurableJournal,
  outbox: DurableOutbox,
  counts: { ack: number; execute: number; publish: number },
  phases: string[] = [],
) {
  const transport: ControlBotTransport = {
    async poll() {
      return { version: 1, cursor: null, orders: [order] };
    },
    async ack() {
      assert.equal(journal.recover().events.at(-1)?.state, 'accepted');
      counts.ack += 1;
      phases.push('ack');
    },
    async publishEvents(request) {
      assert.equal(journal.recover().events.at(-1)?.state, 'completed');
      assert.equal(request.events.at(-1)?.state, 'completed');
      counts.publish += 1;
      phases.push('publish');
    },
    async publishHeartbeat() {},
  };
  const adapter: ProgrammaticAdapter = {
    id: 'test-adapter',
    capabilities: ['git'],
    async execute(capability) {
      assert.equal(journal.recover().events[0]?.state, 'accepted');
      assert.equal(counts.ack, 1);
      counts.execute += 1;
      phases.push('execute');
      return {
        capability,
        data: { ok: true },
        evidence: { code: 'done', summary: 'Synthetic adapter completed', ref: null },
      };
    },
  };
  const client = new ControlBotClient(identity, transport);
  const loopIds = [
    '44444444-4444-7444-8444-444444444444',
    '55555555-5555-7555-8555-555555555555',
  ];
  const loop = new ExecutionLoop({
    journal,
    registry: new AdapterRegistry([adapter]),
    identity,
    now: () => 1_020,
    event_id: () => loopIds.shift() ?? '66666666-6666-7666-8666-666666666666',
  });
  return new RuntimeSupervisor({
    client,
    journal,
    outbox,
    loop,
    now: () => 1_010,
    event_id: () => '33333333-3333-7333-8333-333333333333',
  });
}

test('runtime supervisor durably accepts before ack execute and publish', async () => {
  await withRuntime(async (journal, outbox) => {
    const counts = { ack: 0, execute: 0, publish: 0 };
    const phases: string[] = [];
    const result = await buildRuntime(journal, outbox, counts, phases).tick(1);
    assert.equal(result.processed, 1);
    assert.deepEqual(phases, ['ack', 'execute', 'publish']);
    assert.deepEqual(journal.recover().events.map((event) => event.state), ['accepted', 'started', 'completed']);
    assert.equal(outbox.recover().delivered.length, 2);
  });
});

test('runtime supervisor restart reuses terminal state without duplicate dispatch', async () => {
  await withRuntime(async (journal, outbox) => {
    const counts = { ack: 0, execute: 0, publish: 0 };
    await buildRuntime(journal, outbox, counts).tick(1);
    await buildRuntime(journal, outbox, counts).tick(1);
    assert.deepEqual(counts, { ack: 1, execute: 1, publish: 1 });
    assert.deepEqual(journal.recover().events.map((event) => event.state), ['accepted', 'started', 'completed']);
    assert.equal(outbox.recover().delivered.length, 2);
  });
});
