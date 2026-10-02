import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableOutbox } from '../src/outbox.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

function ackRequest() {
  return {
    version: 1,
    order_id: orderId,
    runner_id: runnerId,
    fingerprint: 'a'.repeat(64),
  };
}

function event(overrides = {}) {
  return {
    version: 1,
    event_id: '33333333-3333-7333-8333-333333333333',
    order_id: orderId,
    runner_id: runnerId,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1_010,
    evidence: { code: 'accepted', summary: 'Order accepted by runner', ref: null },
    ...overrides,
  };
}

function eventsRequest() {
  return {
    version: 1,
    runner_id: runnerId,
    events: [event()],
  };
}

function withOutbox(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-outbox-'));
  try {
    run(join(directory, 'outbox.ndjson'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('durable outbox keeps pending ack and events across restart with stable idempotency', () => {
  withOutbox((path) => {
    const first = new DurableOutbox(path);
    const ack = first.enqueueAck(ackRequest());
    const events = first.enqueueEvents(eventsRequest());
    assert.notEqual(ack.delivery_id, events.delivery_id);

    const afterEnqueue = readFileSync(path, 'utf8');
    const restarted = new DurableOutbox(path);
    const recovered = restarted.recover();
    assert.equal(recovered.pending.length, 2);
    assert.equal(recovered.delivered.length, 0);
    assert.deepEqual(
      recovered.pending.map((delivery) => delivery.kind),
      ['ack', 'events'],
    );

    assert.equal(restarted.enqueueAck(ackRequest()).delivery_id, ack.delivery_id);
    assert.equal(restarted.enqueueEvents(eventsRequest()).delivery_id, events.delivery_id);
    assert.equal(readFileSync(path, 'utf8'), afterEnqueue);

    restarted.markDelivered(ack.delivery_id);
    const afterAck = readFileSync(path, 'utf8');
    restarted.markDelivered(ack.delivery_id);
    assert.equal(readFileSync(path, 'utf8'), afterAck);

    const secondRestart = new DurableOutbox(path).recover();
    assert.equal(secondRestart.pending.length, 1);
    assert.equal(secondRestart.pending[0]?.delivery_id, events.delivery_id);
    assert.equal(secondRestart.delivered.length, 1);
    assert.equal(secondRestart.delivered[0]?.delivery_id, ack.delivery_id);
  });
});

test('durable outbox fails closed on corrupt or conflicting delivery state', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const ack = outbox.enqueueAck(ackRequest());
    const valid = readFileSync(path, 'utf8');

    const conflicting = {
      version: 1,
      op: 'delivered',
      delivery_id: ack.delivery_id,
      fingerprint: 'f'.repeat(64),
    };
    writeFileSync(path, `${valid}${JSON.stringify(conflicting)}\n`, 'utf8');
    const conflictState = readFileSync(path, 'utf8');
    assert.throws(() => new DurableOutbox(path).recover(), /estado de entrega conflictivo/);
    assert.throws(() => new DurableOutbox(path).enqueueEvents(eventsRequest()), /estado de entrega conflictivo/);
    assert.equal(readFileSync(path, 'utf8'), conflictState);

    writeFileSync(path, `${valid}{"version":1`, 'utf8');
    const corruptState = readFileSync(path, 'utf8');
    assert.throws(() => new DurableOutbox(path).recover(), /Outbox truncado/);
    assert.throws(() => new DurableOutbox(path).enqueueEvents(eventsRequest()), /Outbox truncado/);
    assert.equal(readFileSync(path, 'utf8'), corruptState);
  });
});
