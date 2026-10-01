import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capacitySnapshot,
  resultEnvelope,
} from '../src/result.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

function order() {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:52',
    runner_id: runnerId,
    capability: 'git',
    attempt: 1,
    issued_at: 1_000,
    expires_at: 2_000,
    instruction_ref: 'controlbot:instruction:factoryrunner-52',
  };
}

function terminalEvent(overrides = {}) {
  return {
    version: 1,
    event_id: '33333333-3333-7333-8333-333333333333',
    order_id: orderId,
    runner_id: runnerId,
    sequence: 3,
    state: 'completed',
    occurred_at: 1_100,
    evidence: {
      code: 'done',
      summary: 'Adapter completed',
      ref: 'controlbot:evidence:factoryrunner-52',
    },
    ...overrides,
  };
}

function identity() {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.4',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git'],
    max_parallel: 4,
  };
}

function heartbeat(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    sequence: 8,
    observed_at: 1_200,
    status: 'busy',
    capacity: { max: 4, active: 2 },
    active_sessions: ['controlbot:session:one', 'controlbot:session:two'],
    ...overrides,
  };
}

test('result envelope binds order runner sequence and sanitized evidence', () => {
  const result = resultEnvelope(order(), terminalEvent());
  assert.deepEqual(result, {
    version: 1,
    order_id: orderId,
    runner_id: runnerId,
    sequence: 3,
    state: 'completed',
    occurred_at: 1_100,
    evidence: {
      code: 'done',
      summary: 'Adapter completed',
      ref: 'controlbot:evidence:factoryrunner-52',
    },
  });

  assert.throws(
    () => resultEnvelope(order(), terminalEvent({ runner_id: '44444444-4444-7444-8444-444444444444' })),
    /otra orden o runner/,
  );
  assert.throws(
    () => resultEnvelope(order(), terminalEvent({ state: 'progress' })),
    /estado terminal/,
  );
  assert.throws(
    () => resultEnvelope(order(), terminalEvent({
      evidence: { code: 'done', summary: 'token=supersecretvalue', ref: null },
    })),
    /sensible/,
  );
});

test('capacity snapshot is derived from observed runner and queue state', () => {
  const snapshot = capacitySnapshot(
    identity(),
    heartbeat(),
    {
      version: 1,
      runner_id: runnerId,
      observed_at: 1_200,
      queued_orders: 5,
    },
    1_210,
  );

  assert.deepEqual(snapshot, {
    version: 1,
    runner_id: runnerId,
    observed_at: 1_200,
    heartbeat_sequence: 8,
    runner_status: 'busy',
    max_parallel: 4,
    active: 2,
    available: 2,
    queued_orders: 5,
    dispatchable_orders: 2,
  });

  const draining = capacitySnapshot(
    identity(),
    heartbeat({ status: 'draining' }),
    {
      version: 1,
      runner_id: runnerId,
      observed_at: 1_200,
      queued_orders: 5,
    },
    1_210,
  );
  assert.equal(draining.available, 0);
  assert.equal(draining.dispatchable_orders, 0);

  assert.throws(
    () => capacitySnapshot(
      identity(),
      heartbeat(),
      {
        version: 1,
        runner_id: runnerId,
        observed_at: 1_199,
        queued_orders: 5,
      },
      1_210,
    ),
    /mismo snapshot/,
  );

  assert.throws(
    () => capacitySnapshot(
      identity(),
      heartbeat(),
      {
        version: 1,
        runner_id: '44444444-4444-7444-8444-444444444444',
        observed_at: 1_200,
        queued_orders: 5,
      },
      1_210,
    ),
    /otro runner/,
  );
});
