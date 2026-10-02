import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilityManifest,
  orderFingerprint,
  parseExecutionOrder,
  resourceSnapshot,
  telemetryEnvelope,
} from '../src/index.ts';
import type { CapabilityAdapterSource } from '../src/index.ts';
import { stableSha256 } from '../src/validation.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

class FakeAdapter implements CapabilityAdapterSource {
  readonly id: string;
  readonly capabilities: readonly string[];

  constructor(id: string, capabilities: readonly string[]) {
    this.id = id;
    this.capabilities = capabilities;
  }
}

function adapters() {
  return [
    new FakeAdapter('browser-execution', ['browser.navigate']),
    new FakeAdapter('git-read', ['git.head']),
  ];
}

function identity(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git.head', 'browser.navigate'],
    max_parallel: 4,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:66',
    runner_id: runnerId,
    capability: 'git.head',
    attempt: 1,
    issued_at: 1_100,
    expires_at: 1_500,
    instruction_ref: 'controlbot:instruction:factoryrunner-66',
    ...overrides,
  };
}

function heartbeat(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    sequence: 10,
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
    queued_orders: 2,
    ...overrides,
  };
}

test('TelemetryEnvelope links runner order observation and manifest without raw secret material', () => {
  const actual = telemetryEnvelope(
    identity(),
    adapters(),
    order(),
    heartbeat(),
    queue(),
    1_215,
    30,
    {
      'queue-latency-ms': 42,
      state: 'busy',
      degraded: false,
    },
  );

  const manifest = capabilityManifest(identity(), adapters());
  const resources = resourceSnapshot(identity(), heartbeat(), queue(), 1_215, 30);

  assert.equal(actual.runner_id, runnerId);
  assert.equal(actual.order_id, orderId);
  assert.equal(actual.work_item_id, 'factoryrunner:work:66');
  assert.equal(actual.capability, 'git.head');
  assert.equal(actual.observed_at, 1_200);
  assert.equal(actual.instruction_ref, 'controlbot:instruction:factoryrunner-66');
  assert.equal(actual.manifest_fingerprint, manifest.fingerprint);
  assert.equal(actual.order_fingerprint, orderFingerprint(parseExecutionOrder(order())));
  assert.equal(actual.resource_fingerprint, stableSha256(resources));
  assert.deepEqual(actual.metrics, {
    degraded: false,
    'queue-latency-ms': 42,
    state: 'busy',
  });
  assert.equal(actual.authority, 'unchanged');
  assert.equal(actual.execute_actions, false);
  assert.match(actual.fingerprint, /^[0-9a-f]{64}$/);

  const changedAttempt = telemetryEnvelope(
    identity(), adapters(), order({ attempt: 2 }), heartbeat(), queue(), 1_215, 30, {},
  );
  assert.notEqual(changedAttempt.order_fingerprint, actual.order_fingerprint);
  assert.notEqual(changedAttempt.fingerprint, actual.fingerprint);

  const serialized = JSON.stringify(actual);
  assert.ok(!serialized.includes('active_sessions'));
  assert.ok(!serialized.includes('browser.navigate'));
});

test('TelemetryEnvelope fails closed on secret-like or oversized payload', () => {
  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order(),
      heartbeat(),
      queue(),
      1_215,
      30,
      { status: 'token=supersecretvalue' },
    ),
    /sensible/,
  );

  for (const sensitiveKey of ['token', 'password', 'dsn']) {
    assert.throws(
      () => telemetryEnvelope(
        identity(),
        adapters(),
        order(),
        heartbeat(),
        queue(),
        1_215,
        30,
        { [sensitiveKey]: 'present' },
      ),
      /sensible/,
    );
  }

  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order(),
      heartbeat(),
      queue(),
      1_215,
      30,
      { status: 'x'.repeat(161) },
    ),
    /inválido/,
  );

  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order(),
      heartbeat(),
      queue(),
      1_215,
      30,
      Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`metric${index}`, index])),
    ),
    /límite/,
  );

  const aggregateOversizedMetrics = Object.fromEntries(
    Array.from({ length: 13 }, (_, index) => [`metric-${index}`, 'x'.repeat(160)]),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(aggregateOversizedMetrics), 'utf8') > 2_048);
  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order(),
      heartbeat(),
      queue(),
      1_215,
      30,
      aggregateOversizedMetrics,
    ),
    /tamaño permitido/,
  );

  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order({ runner_id: '33333333-3333-7333-8333-333333333333' }),
      heartbeat(),
      queue(),
      1_215,
      30,
      {},
    ),
    /otro runner/,
  );

  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order({ capability: 'db.write' }),
      heartbeat(),
      queue(),
      1_215,
      30,
      {},
    ),
    /no declarada/,
  );


  assert.throws(
    () => telemetryEnvelope(
      identity(),
      adapters(),
      order({ expires_at: 1_215 }),
      heartbeat(),
      queue(),
      1_215,
      30,
      {},
    ),
    /ventana ejecutable/,
  );
});
