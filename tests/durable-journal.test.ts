import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableJournal, DurableJournalError } from '../src/journal.ts';

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


function assertJournalRejectsNoncanonicalLines(variants: (valid: string) => readonly string[]): void {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    const original = readFileSync(path, 'utf8');
    for (const changed of variants(original)) {
      assert.notEqual(changed, original);
      assert.deepEqual(JSON.parse(changed), JSON.parse(original));
      writeFileSync(path, changed, 'utf8');
      assert.throws(() => journal.recover(), /no canónico/);
      assert.throws(() => journal.appendOrder(order()), /no canónico/);
      assert.equal(readFileSync(path, 'utf8'), changed);
    }
  });
}

test('AC01 durable journal denies duplicate top-level kind and version keys', () => {
  assertJournalRejectsNoncanonicalLines((valid) => [
    valid.replace('"kind":"order"', '"kind":"event","kind":"order"'),
    valid.replace('"version":1', '"version":2,"version":1'),
  ]);
});

test('AC02 durable journal denies duplicate nested payload keys without replay', () => {
  assertJournalRejectsNoncanonicalLines((valid) => [
    valid.replace('"payload":', '"payload":{"version":1},"payload":'),
    valid.replace('"order_id":"', '"order_id":"invalid","order_id":"'),
  ]);
});

test('AC03 durable journal rejects noncanonical NDJSON but recovers writer records', () => {
  assertJournalRejectsNoncanonicalLines((valid) => [
    valid.replace('"kind":"order"', '"kind": "order"'),
    valid.replace('"kind":"order"', String.raw`"\u006bind":"order"`),
  ]);
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    journal.appendEvent(event());
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.orders.length, 1);
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

function expectProtectedJournalFailure(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DurableJournalError);
    assert.ok(error.code === 'journal_io' || error.code === 'journal_invalid');
    assert.ok(!error.message.includes('PRIVATE_JOURNAL_CANARY'));
    return true;
  });
}

test('AC01 journal symlink denies recovery and append without touching target', () => {
  withJournal((path) => {
    const target = path + '.target';
    const canary = 'PRIVATE_JOURNAL_CANARY\n';
    writeFileSync(target, canary, 'utf8');
    symlinkSync(target, path);
    const journal = new DurableJournal(path);
    assert.throws(() => journal.recover(), (error: unknown) => {
      assert.ok(error instanceof DurableJournalError);
      assert.equal(error.code, 'journal_io');
      assert.ok(!error.message.includes(canary.trim()));
      return true;
    });
    expectProtectedJournalFailure(() => journal.appendOrder(order()));
    assert.equal(readFileSync(target, 'utf8'), canary);
  });
});

test('AC02 journal dangling symlink and nonregular file fail closed', () => {
  withJournal((path) => {
    const missing = path + '.missing';
    symlinkSync(missing, path);
    const journal = new DurableJournal(path);
    expectProtectedJournalFailure(() => journal.recover());
    expectProtectedJournalFailure(() => journal.appendOrder(order()));
    assert.equal(existsSync(missing), false);
  });
  withJournal((path) => {
    mkdirSync(path);
    const journal = new DurableJournal(path);
    expectProtectedJournalFailure(() => journal.recover());
    expectProtectedJournalFailure(() => journal.appendOrder(order()));
  });
  if (process.platform !== 'win32') {
    withJournal((path) => {
      execFileSync('mkfifo', [path]);
      const journal = new DurableJournal(path);
      expectProtectedJournalFailure(() => journal.recover());
      expectProtectedJournalFailure(() => journal.appendOrder(order()));
    });
  }
});

test('AC03 journal regular file creation restart and idempotency preserved', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    assert.equal(existsSync(path), false);
    assert.deepEqual(journal.recover(), { orders: [], events: [] });
    journal.appendOrder(order());
    journal.appendEvent(event());
    const previous = readFileSync(path, 'utf8');
    assert.equal(previous.split('\n').filter(Boolean).length, 2);
    const restarted = new DurableJournal(path);
    assert.equal(restarted.recover().orders.length, 1);
    assert.equal(restarted.recover().events.length, 1);
    restarted.appendOrder(order());
    restarted.appendEvent(event());
    assert.equal(readFileSync(path, 'utf8'), previous);
  });
});


const JOURNAL_LIMIT_BYTES = 16 * 1024 * 1024;

function repeatedOrderFixture(path: string, count: number): number {
  const line = JSON.stringify({ version: 1, kind: 'order', payload: order() }) + '\n';
  writeFileSync(path, line.repeat(count), 'utf8');
  return Buffer.byteLength(line, 'utf8');
}

function journalHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('AC01 journal append rejects crossing size limit without changes', () => {
  withJournal((path) => {
    const orderLineBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, kind: 'order', payload: order() }) + '\n',
    );
    const eventBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, kind: 'event', payload: event() }) + '\n',
    );
    const lineBytes = repeatedOrderFixture(path, Math.floor(JOURNAL_LIMIT_BYTES / orderLineBytes));
    assert.equal(lineBytes, orderLineBytes);
    const beforeSize = statSync(path).size;
    const beforeHash = journalHash(path);
    assert.ok(beforeSize <= JOURNAL_LIMIT_BYTES);
    assert.ok(JOURNAL_LIMIT_BYTES - beforeSize < eventBytes);

    const journal = new DurableJournal(path);
    assert.throws(() => journal.appendEvent(event()), (error: unknown) => {
      assert.ok(error instanceof DurableJournalError);
      assert.equal(error.code, 'journal_invalid');
      assert.match(error.message, /límite permitido/);
      return true;
    });
    assert.equal(statSync(path).size, beforeSize);
    assert.equal(journalHash(path), beforeHash);
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.orders.length, 1);
    assert.equal(recovered.events.length, 0);
  });
});

test('AC02 journal append fits remaining size and recovers', () => {
  withJournal((path) => {
    const lineBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, kind: 'order', payload: order() }) + '\n',
    );
    const eventBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, kind: 'event', payload: event() }) + '\n',
    );
    repeatedOrderFixture(path, Math.floor((JOURNAL_LIMIT_BYTES - eventBytes) / lineBytes));
    const beforeSize = statSync(path).size;
    assert.ok(beforeSize + eventBytes <= JOURNAL_LIMIT_BYTES);
    const journal = new DurableJournal(path);
    journal.appendEvent(event());
    assert.equal(statSync(path).size, beforeSize + eventBytes);
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.orders.length, 1);
    assert.equal(recovered.events.length, 1);
    assert.equal(recovered.events[0]?.event_id, event().event_id);
    const afterHash = journalHash(path);
    journal.appendEvent(event());
    assert.equal(journalHash(path), afterHash);
  });
});

test('AC03 oversized existing journal is never appended', () => {
  withJournal((path) => {
    const lineBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, kind: 'order', payload: order() }) + '\n',
    );
    repeatedOrderFixture(path, Math.floor(JOURNAL_LIMIT_BYTES / lineBytes) + 1);
    const beforeSize = statSync(path).size;
    const beforeHash = journalHash(path);
    assert.ok(beforeSize > JOURNAL_LIMIT_BYTES);
    const journal = new DurableJournal(path);
    assert.throws(() => journal.recover(), /límite permitido/);
    assert.throws(() => journal.appendEvent(event()), /límite permitido/);
    assert.equal(statSync(path).size, beforeSize);
    assert.equal(journalHash(path), beforeHash);
  });
});

test('AC01 journal rejects malformed UTF-8 before replay or append', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    journal.appendEvent(event({ evidence: { code: 'accepted', summary: 'alpha beta PRIVATE_UTF8_CANARY', ref: null } }));
    const bytes = readFileSync(path);
    const position = bytes.indexOf(Buffer.from('alpha beta PRIVATE_UTF8_CANARY'));
    assert.ok(position > 0);
    const broken = Buffer.from(bytes);
    broken[position + 6] = 0x80; // malformed standalone continuation byte
    writeFileSync(path, broken);
    for (const run of [
      () => new DurableJournal(path).recover(),
      () => journal.appendOrder(order()),
      () => journal.appendEvent(event()),
    ]) {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof DurableJournalError);
        assert.equal(error.code, 'journal_invalid');
        assert.doesNotMatch(error.message, /PRIVATE_UTF8_CANARY/);
        return true;
      });
      assert.deepEqual(readFileSync(path), broken);
    }
  });
});

test('AC03 journal authentic Unicode including U+FFFD round-trips unchanged', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    const summary = 'Árbol 🤖 \uFFFD intacto';
    journal.appendEvent(event({ evidence: { code: 'accepted', summary, ref: null } }));
    const bytes = readFileSync(path);
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.events[0]?.evidence.summary, summary);
    journal.appendEvent(event({ evidence: { code: 'accepted', summary, ref: null } }));
    assert.deepEqual(readFileSync(path), bytes);
  });
});

test('AC01 bounded journal rejects oversized sparse before unbounded read', () => {
  withJournal((path) => {
    writeFileSync(path, '');
    truncateSync(path, 16 * 1024 * 1024 + 1);
    const before = statSync(path).size;
    assert.throws(
      () => new DurableJournal(path).recover(),
      (error: unknown) => error instanceof DurableJournalError
        && error.code === 'journal_invalid',
    );
    assert.equal(statSync(path).size, before);
    const source = readFileSync(new URL('../src/journal.ts', import.meta.url), 'utf8');
    assert.match(source, /readSync\(descriptor, chunk, 0, chunk\.length, null\)/);
    assert.doesNotMatch(source, /readFileSync\(descriptor\)/);
  });
});

test('AC02 bounded journal preserves regular recovery and idempotency', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    journal.appendOrder(order());
    journal.appendEvent(event());
    const original = readFileSync(path);
    const recovered = new DurableJournal(path).recover();
    assert.equal(recovered.orders.length, 1);
    assert.equal(recovered.events.length, 1);
    journal.appendOrder(order());
    journal.appendEvent(event());
    assert.deepEqual(readFileSync(path), original);
  });
});

test('AC03 bounded journal preserves ENOENT and nonregular fail closed', () => {
  withJournal((path) => {
    const journal = new DurableJournal(path);
    assert.deepEqual(journal.recover(), { orders: [], events: [] });
    const target = path + '.target';
    const canary = 'PRIVATE_JOURNAL_CANARY\n';
    writeFileSync(target, canary, 'utf8');
    symlinkSync(target, path);
    assert.throws(() => journal.recover(), DurableJournalError);
    assert.equal(readFileSync(target, 'utf8'), canary);
  });
  withJournal((path) => {
    mkdirSync(path);
    assert.throws(() => new DurableJournal(path).recover(), DurableJournalError);
  });
});
