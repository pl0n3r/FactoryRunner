import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlBotClient,
  ControlBotClientError,
  parseExecutionOrder,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from '../src/index.ts';
import type {
  ControlBotAckRequest,
  ControlBotEventsRequest,
  ControlBotHeartbeatRequest,
  ControlBotPollRequest,
  ControlBotTransport,
} from '../src/index.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';

function identity() {
  return parseRunnerIdentity({
    version: 1,
    runner_id: RUNNER_ID,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.4',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git.head', 'git.status'],
    max_parallel: 2,
  });
}

function order(overrides = {}) {
  return {
    version: 1,
    order_id: ORDER_ID,
    work_item_id: 'factoryrunner:work:18',
    runner_id: RUNNER_ID,
    capability: 'git.head',
    attempt: 1,
    issued_at: 1_000,
    expires_at: 2_000,
    instruction_ref: 'controlbot:instruction:factoryrunner-18',
    ...overrides,
  };
}

class FakeTransport implements ControlBotTransport {
  pollRequests: ControlBotPollRequest[] = [];
  ackRequests: ControlBotAckRequest[] = [];
  eventRequests: ControlBotEventsRequest[] = [];
  heartbeatRequests: ControlBotHeartbeatRequest[] = [];
  pollResponse: unknown = { version: 1, cursor: 'controlbotcursor:next', orders: [order()] };
  failure: Error | null = null;

  async poll(request: ControlBotPollRequest): Promise<unknown> {
    this.pollRequests.push(request);
    if (this.failure) throw this.failure;
    return this.pollResponse;
  }

  async ack(request: ControlBotAckRequest): Promise<void> {
    this.ackRequests.push(request);
    if (this.failure) throw this.failure;
  }

  async publishEvents(request: ControlBotEventsRequest): Promise<void> {
    this.eventRequests.push(request);
    if (this.failure) throw this.failure;
  }

  async publishHeartbeat(request: ControlBotHeartbeatRequest): Promise<void> {
    this.heartbeatRequests.push(request);
    if (this.failure) throw this.failure;
  }
}

test('poll envelope is exact, bounded and runner-scoped', async () => {
  const transport = new FakeTransport();
  const client = new ControlBotClient(identity(), transport);
  const result = await client.poll('controlbotcursor:start', 8, 1_500);

  assert.deepEqual(transport.pollRequests[0], {
    version: 1,
    runner_id: RUNNER_ID,
    capabilities: ['git.head', 'git.status'],
    cursor: 'controlbotcursor:start',
    limit: 8,
  });
  assert.equal(result.cursor, 'controlbotcursor:next');
  assert.equal(result.orders.length, 1);
  await assert.rejects(() => client.poll('badcursor', 8, 1_500), /Cursor de ControlBot inválido/);
  await assert.rejects(() => client.poll(null, 65, 1_500), /limit inválido/);
});

test('poll validates orders, collapses identical duplicates and rejects conflicts', async () => {
  const transport = new FakeTransport();
  const client = new ControlBotClient(identity(), transport);

  transport.pollResponse = { version: 1, cursor: null, orders: [order(), order()] };
  const result = await client.poll(null, 4, 1_500);
  assert.equal(result.orders.length, 1);

  transport.pollResponse = { version: 1, cursor: null, orders: [order(), order({ attempt: 2 })] };
  await assert.rejects(
    () => client.poll(null, 4, 1_500),
    (error: unknown) => error instanceof ControlBotClientError && error.message === 'controlbot_protocol_invalid',
  );

  transport.pollResponse = { version: 1, cursor: null, orders: [order({ runner_id: '33333333-3333-7333-8333-333333333333' })] };
  await assert.rejects(() => client.poll(null, 4, 1_500), /controlbot_protocol_invalid/);
});

test('ack uses only validated identity and fingerprint fields', async () => {
  const transport = new FakeTransport();
  const client = new ControlBotClient(identity(), transport);
  const parsed = parseExecutionOrder(order());

  await assert.rejects(() => client.ack(parsed), /controlbot_protocol_invalid/);
  await client.poll(null, 4, 1_500);
  const result = await client.ack(parsed);

  assert.equal(result.acknowledged, true);
  assert.deepEqual(Object.keys(transport.ackRequests[0]).sort(), ['fingerprint', 'order_id', 'runner_id', 'version']);
  assert.equal(JSON.stringify(transport.ackRequests[0]).includes('instruction_ref'), false);
  assert.match(transport.ackRequests[0]?.fingerprint ?? '', /^[0-9a-f]{64}$/);
});

test('publishEvents requires validated order, runner match and monotonic batch sequence', async () => {
  const transport = new FakeTransport();
  const client = new ControlBotClient(identity(), transport);
  await client.poll(null, 4, 1_500);

  const event1 = {
    version: 1,
    event_id: '44444444-4444-7444-8444-444444444444',
    order_id: ORDER_ID,
    runner_id: RUNNER_ID,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1_510,
    evidence: { code: 'accepted', summary: 'Order accepted', ref: null },
  } as const;
  const event2 = {
    ...event1,
    event_id: '55555555-5555-7555-8555-555555555555',
    sequence: 2,
    state: 'started',
    occurred_at: 1_520,
  } as const;

  assert.deepEqual(await client.publishEvents([event1, event2]), { published: 2 });
  assert.equal(transport.eventRequests[0]?.runner_id, RUNNER_ID);
  await assert.rejects(() => client.publishEvents([event2, event1]), /controlbot_protocol_invalid/);
  await assert.rejects(
    () => client.publishEvents([{ ...event1, runner_id: '66666666-6666-7666-8666-666666666666' }]),
    /controlbot_protocol_invalid/,
  );
});

test('heartbeat is runner-bound and provider errors collapse to generic code', async () => {
  const transport = new FakeTransport();
  const client = new ControlBotClient(identity(), transport);
  const heartbeat = parseRunnerHeartbeat({
    version: 1,
    runner_id: RUNNER_ID,
    sequence: 7,
    observed_at: 1_500,
    status: 'ready',
    capacity: { max: 2, active: 0 },
    active_sessions: [],
  });

  assert.deepEqual(await client.publishHeartbeat(heartbeat), { published: true, sequence: 7 });
  assert.equal(transport.heartbeatRequests[0]?.runner_id, RUNNER_ID);

  await assert.rejects(
    () => client.publishHeartbeat({ ...heartbeat, runner_id: '77777777-7777-7777-8777-777777777777' }),
    /controlbot_protocol_invalid/,
  );

  transport.failure = new Error('https://provider.example/?token=supersecret stderr=private');
  await assert.rejects(
    () => client.publishHeartbeat(heartbeat),
    (error: unknown) => {
      assert.ok(error instanceof ControlBotClientError);
      assert.equal(error.message, 'controlbot_transport_failed');
      assert.equal(error.message.includes('provider.example'), false);
      assert.equal(error.message.includes('supersecret'), false);
      return true;
    },
  );
});
