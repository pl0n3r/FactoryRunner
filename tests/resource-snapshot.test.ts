import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceSnapshot } from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';

function identity(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git.head'],
    max_parallel: 4,
    ...overrides,
  };
}

function heartbeat(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    sequence: 9,
    observed_at: 1_200,
    status: 'busy',
    capacity: { max: 4, active: 1 },
    active_sessions: ['controlbot:session:one'],
    ...overrides,
  };
}

function queue(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    observed_at: 1_200,
    queued_orders: 3,
    ...overrides,
  };
}

test('ResourceSnapshot is derived from observed runtime state with freshness', () => {
  const snapshot = resourceSnapshot(
    identity(),
    heartbeat(),
    queue(),
    1_215,
    30,
  );

  assert.deepEqual(snapshot, {
    version: 1,
    runner_id: runnerId,
    observed_at: 1_200,
    heartbeat_sequence: 9,
    runner_status: 'busy',
    max_parallel: 4,
    active: 1,
    available: 3,
    queued_orders: 3,
    dispatchable_orders: 3,
    freshness: 'fresh',
    age_seconds: 15,
    stale_after_seconds: 30,
  });
});

test('ResourceSnapshot fails closed on stale future or incoherent observation', () => {
  assert.throws(
    () => resourceSnapshot(identity(), heartbeat(), queue(), 1_231, 30),
    /stale/,
  );

  assert.throws(
    () => resourceSnapshot(
      identity(),
      heartbeat({ observed_at: 1_220 }),
      queue({ observed_at: 1_220 }),
      1_215,
      30,
    ),
    /futuro/,
  );

  assert.throws(
    () => resourceSnapshot(
      identity(),
      heartbeat(),
      queue({ observed_at: 1_199 }),
      1_215,
      30,
    ),
    /mismo snapshot/,
  );

  assert.throws(
    () => resourceSnapshot(
      identity({ max_parallel: 2 }),
      heartbeat(),
      queue(),
      1_215,
      30,
    ),
    /no coincide/,
  );

  assert.throws(
    () => resourceSnapshot(identity(), heartbeat(), queue(), 1_215, 0),
    /stale_after_seconds inválido/,
  );
});
