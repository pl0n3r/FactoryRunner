import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableJournal } from '../src/journal.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

function order(overrides = {}) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:50',
    runner_id: runnerId,
    capability: 'git',
    attempt: 1,
    issued_at: 1_000,
    expires_at: 2_000,
    instruction_ref: 'controlbot:instruction:factoryrunner-50',
    ...overrides,
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
function withJournal(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-journal-'));
  try {
    run(join(directory, 'runner.ndjson'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('durable journal recovers valid orders and events after restart', () => {
  withJournal((path) => {
    const first = new DurableJournal(path);
    first.appendOrder(order());
    first.appendEvent(event());
    first.appendEvent(event({
      event_id: '44444444-4444-7444-8444-444444444444',
      sequence: 2,
      state: 'started',
      occurred_at: 1_020,
    }));

    const restarted = new DurableJournal(path);
    const recovered = restarted.recover();
    assert.equal(recovered.orders.length, 1);
    assert.equal(recovered.events.length, 2);
    assert.equal(recovered.orders[0]?.runner_id, runnerId);
    assert.deepEqual(recovered.events.map((item) => item.sequence), [1, 2]);

    const beforeDuplicate = readFileSync(path, 'utf8');
    restarted.appendOrder(order());
    restarted.appendEvent(event());
    assert.equal(readFileSync(path, 'utf8'), beforeDuplicate);
  });
});

test('AC01 durable journal denies duplicate top-level kind and version keys', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    const valid = readFileSync(path, 'utf8');
    const variants = [
      valid.replace('"kind":"order"', '"kind":"event","kind":"order"'),
      valid.replace('"version":1', '"version":2,"version":1'),
    ];
    for (const ambiguous of variants) {
      assert.notEqual(ambiguous, valid);
      assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
      writeFileSync(path, ambiguous, 'utf8');
      assert.throws(() => new DurableJournal(path).recover(), /no canónico/);
      assert.throws(() => new DurableJournal(path).appendOrder(order()), /no canónico/);
      assert.equal(readFileSync(path, 'utf8'), ambiguous);
    }
  });
});

test('AC02 durable journal denies duplicate nested payload keys without replay', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    const valid = readFileSync(path, 'utf8');
    const variants = [
      valid.replace('"payload":', '"payload":{"version":1},"payload":'),
      valid.replace('"order_id":"', '"order_id":"invalid","order_id":"'),
    ];
    for (const ambiguous of variants) {
      assert.notEqual(ambiguous, valid);
      assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
      writeFileSync(path, ambiguous, 'utf8');
      assert.throws(() => new DurableJournal(path).recover(), /no canónico/);
      assert.equal(readFileSync(path, 'utf8'), ambiguous);
    }
  });
});

test('AC03 durable journal rejects noncanonical NDJSON but recovers writer records', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    const valid = readFileSync(path, 'utf8');
    const variants = [
      valid.replace('"kind":"order"', '"kind": "order"'),
      valid.replace('"kind":"order"', String.raw`"\u006bind":"order"`),
    ];
    for (const ambiguous of variants) {
      assert.notEqual(ambiguous, valid);
      assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
      writeFileSync(path, ambiguous, 'utf8');
      assert.throws(() => new DurableJournal(path).recover(), /no canónico/);
    }
    writeFileSync(path, valid, 'utf8');
    journal.appendEvent(event());
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.orders.length, 1);
    assert.equal(recovered.events.length, 1);
    assert.equal(recovered.events[0]?.event_id, event().event_id);
  });
});

test('durable journal fails closed on corrupt or conflicting records without replay', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    journal.appendEvent(event());

    const valid = readFileSync(path, 'utf8');
    assert.throws(
      () => journal.appendOrder(order({ attempt: 2 })),
      /Reuso conflictivo de order_id/,
    );
    assert.equal(readFileSync(path, 'utf8'), valid);

    assert.throws(
      () => journal.appendEvent(event({ state: 'started' })),
      /Reuso conflictivo de event_id/,
    );
    assert.equal(readFileSync(path, 'utf8'), valid);

    writeFileSync(path, `${valid}{"version":1`, 'utf8');
    const corrupted = readFileSync(path, 'utf8');
    assert.throws(() => new DurableJournal(path).recover(), /Journal truncado/);
    assert.throws(
      () => new DurableJournal(path).appendEvent(event({
        event_id: '55555555-5555-7555-8555-555555555555',
        sequence: 2,
        state: 'started',
        occurred_at: 1_020,
      })),
      /Journal truncado/,
    );
    assert.equal(readFileSync(path, 'utf8'), corrupted);
  });
});
