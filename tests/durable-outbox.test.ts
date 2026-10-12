import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableOutbox, DurableOutboxError } from '../src/outbox.ts';

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

test('AC01 durable outbox denies conflicting top-level op declarations', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    outbox.enqueueAck(ackRequest());
    const valid = readFileSync(path, 'utf8');
    const ambiguous = valid.replace('"op":"enqueue"', '"op":"discard","op":"enqueue"');
    assert.notEqual(ambiguous, valid);
    assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
    writeFileSync(path, ambiguous, 'utf8');
    assert.throws(() => new DurableOutbox(path).recover(), /no canónico/);
    assert.equal(readFileSync(path, 'utf8'), ambiguous);
  });
});

test('AC02 durable outbox denies nested duplicate fingerprints and requests', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const delivery = outbox.enqueueAck(ackRequest());
    const valid = readFileSync(path, 'utf8');
    const fingerprint = '"fingerprint":"' + delivery.fingerprint + '"';
    const fake = '"fingerprint":"' + 'f'.repeat(64) + '",' + fingerprint;
    const changes = [
      valid.replace(fingerprint, fake),
      valid.replace('"request":', '"request":{"version":1},"request":'),
    ];
    for (const ambiguous of changes) {
      assert.notEqual(ambiguous, valid);
      assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
      writeFileSync(path, ambiguous, 'utf8');
      assert.throws(() => new DurableOutbox(path).recover(), /no canónico/);
    }
  });
});

test('AC03 durable outbox rejects noncanonical NDJSON but replays genuine append-only records', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const ack = outbox.enqueueAck(ackRequest());
    const valid = readFileSync(path, 'utf8');
    for (const ambiguous of [
      valid.replace('"op":"enqueue"', '"op": "enqueue"'),
      valid.replace('"op":"enqueue"', '"\\u006fp":"enqueue"'),
    ]) {
      assert.notEqual(ambiguous, valid);
      assert.deepEqual(JSON.parse(ambiguous), JSON.parse(valid));
      writeFileSync(path, ambiguous, 'utf8');
      assert.throws(() => new DurableOutbox(path).recover(), /no canónico/);
    }
    writeFileSync(path, valid, 'utf8');
    assert.equal(new DurableOutbox(path).recover().pending[0]?.delivery_id, ack.delivery_id);
    outbox.markDelivered(ack.delivery_id);
    assert.equal(new DurableOutbox(path).recover().delivered[0]?.delivery_id, ack.delivery_id);
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

function expectProtectedFailure(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof DurableOutboxError
    && (error.code === 'outbox_invalid' || error.code === 'outbox_io')
    && !error.message.includes('PRIVATE_TARGET_SENTINEL'));
}

test('AC01 symlink outbox does not read or write target', () => {
  withOutbox((path) => {
    const target = path + '.target';
    const canary = 'PRIVATE_TARGET_SENTINEL\n';
    writeFileSync(target, canary, 'utf8');
    symlinkSync(target, path);
    const outbox = new DurableOutbox(path);
    expectProtectedFailure(() => outbox.recover());
    expectProtectedFailure(() => outbox.enqueueAck(ackRequest()));
    assert.equal(readFileSync(target, 'utf8'), canary);
  });
});

test('AC02 dangling symlink and nonregular file fail closed', () => {
  withOutbox((path) => {
    const absentTarget = path + '.absent';
    symlinkSync(absentTarget, path);
    const outbox = new DurableOutbox(path);
    expectProtectedFailure(() => outbox.recover());
    expectProtectedFailure(() => outbox.enqueueAck(ackRequest()));
    assert.equal(existsSync(absentTarget), false);
  });
  withOutbox((path) => {
    mkdirSync(path);
    const outbox = new DurableOutbox(path);
    expectProtectedFailure(() => outbox.recover());
    expectProtectedFailure(() => outbox.enqueueEvents(eventsRequest()));
  });
});

test('AC03 regular outbox append and restart remain compatible', () => {
  withOutbox((path) => {
    assert.equal(existsSync(path), false);
    const first = new DurableOutbox(path);
    const ack = first.enqueueAck(ackRequest());
    const events = first.enqueueEvents(eventsRequest());
    const serialized = readFileSync(path, 'utf8');
    assert.equal(serialized.split('\n').filter(Boolean).length, 2);
    const restarted = new DurableOutbox(path);
    assert.deepEqual(restarted.recover().pending.map((item) => item.delivery_id),
      [ack.delivery_id, events.delivery_id]);
    assert.equal(restarted.enqueueAck(ackRequest()).delivery_id, ack.delivery_id);
    assert.equal(readFileSync(path, 'utf8'), serialized);
    restarted.markDelivered(ack.delivery_id);
    assert.deepEqual(new DurableOutbox(path).recover().delivered.map((item) => item.delivery_id),
      [ack.delivery_id]);
  });
});

test('AC01 bounded reader rejects oversized sparse outbox before unbounded read', () => {
  withOutbox((path) => {
    writeFileSync(path, '');
    truncateSync(path, 16 * 1024 * 1024 + 1);
    const sizeBefore = statSync(path).size;
    assert.throws(
      () => new DurableOutbox(path).recover(),
      (error: unknown) => error instanceof DurableOutboxError
        && error.code === 'outbox_invalid'
        && !error.message.includes('PRIVATE_TARGET_SENTINEL'),
    );
    assert.equal(statSync(path).size, sizeBefore);
    // Enforce a true capped read, not only a post-read size comparison.
    const source = readFileSync(new URL('../src/outbox.ts', import.meta.url), 'utf8');
    assert.match(source, /readSync\(descriptor, chunk, 0, chunk\.length, null\)/);
    assert.doesNotMatch(source, /readFileSync\(descriptor/);
  });
});

test('AC02 bounded reader preserves regular recovery and idempotency', () => {
  withOutbox((path) => {
    const first = new DurableOutbox(path);
    const ack = first.enqueueAck(ackRequest());
    const events = first.enqueueEvents(eventsRequest());
    const original = readFileSync(path, 'utf8');
    assert.deepEqual(new DurableOutbox(path).recover().pending.map((d) => d.delivery_id),
      [ack.delivery_id, events.delivery_id]);
    assert.equal(first.enqueueAck(ackRequest()).delivery_id, ack.delivery_id);
    assert.equal(readFileSync(path, 'utf8'), original);
    first.markDelivered(ack.delivery_id);
    assert.deepEqual(new DurableOutbox(path).recover().delivered.map((d) => d.delivery_id), [ack.delivery_id]);
    writeFileSync(path, original + '{"op":"enqueue"', 'utf8');
    const invalid = readFileSync(path, 'utf8');
    assert.throws(() => first.enqueueAck(ackRequest()), /Outbox truncado/);
    assert.equal(readFileSync(path, 'utf8'), invalid);
  });
});

test('AC03 bounded reader preserves ENOENT and nonregular fail closed', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    assert.deepEqual(outbox.recover(), { pending: [], delivered: [] });
    const target = path + '.target';
    const canary = 'PRIVATE_TARGET_SENTINEL\n';
    writeFileSync(target, canary, 'utf8');
    symlinkSync(target, path);
    expectProtectedFailure(() => outbox.recover());
    expectProtectedFailure(() => outbox.enqueueAck(ackRequest()));
    assert.equal(readFileSync(target, 'utf8'), canary);
  });
  withOutbox((path) => {
    mkdirSync(path);
    expectProtectedFailure(() => new DurableOutbox(path).recover());
  });
});

test('AC02 outbox rejects malformed UTF-8 before replay or enqueue', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    outbox.enqueueEvents(eventsRequest());
    const bytes = readFileSync(path);
    const position = bytes.indexOf(Buffer.from('Order accepted by runner'));
    assert.ok(position > 0);
    const broken = Buffer.from(bytes);
    broken[position + 6] = 0x80; // synthetically corrupt the stored summary byte
    writeFileSync(path, broken);
    for (const run of [
      () => new DurableOutbox(path).recover(),
      () => outbox.enqueueAck(ackRequest()),
      () => outbox.enqueueEvents(eventsRequest()),
    ]) {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_invalid');
        assert.doesNotMatch(error.message, /Order accepted by runner/);
        return true;
      });
      assert.deepEqual(readFileSync(path), broken);
    }
  });
});

test('AC03 outbox authentic Unicode including U+FFFD round-trips unchanged', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const summary = 'Árbol 🤖 \uFFFD intacto';
    const request = { version: 1, runner_id: runnerId,
      events: [event({ evidence: { code: 'accepted', summary, ref: null } })] };
    const delivery = outbox.enqueueEvents(request);
    const bytes = readFileSync(path);
    const recovered = new DurableOutbox(path).recover();
    assert.equal(recovered.pending[0]?.delivery_id, delivery.delivery_id);
    assert.equal(recovered.pending[0]?.kind, 'events');
    assert.equal(recovered.pending[0]?.kind === 'events'
      ? recovered.pending[0]?.request.events[0]?.evidence.summary : null, summary);
    outbox.enqueueEvents(request);
    assert.deepEqual(readFileSync(path), bytes);
  });
});


const OUTBOX_TOTAL_LIMIT = 16 * 1024 * 1024;

/** Fill a valid append-only outbox near its total cap without using real data. */
function denseOutbox(path: string, reserveBytes: number): {
  remaining: number;
  ackId: string;
  deliveredLineBytes: number;
} {
  const outbox = new DurableOutbox(path);
  const ack = outbox.enqueueAck(ackRequest());
  outbox.markDelivered(ack.delivery_id);
  const initial = readFileSync(path, 'utf8');
  const records = initial.trimEnd().split('\n');
  assert.equal(records.length, 2);
  const deliveredLine = records[1] + '\n';
  const lineBytes = Buffer.byteLength(deliveredLine, 'utf8');
  const copies = Math.floor((OUTBOX_TOTAL_LIMIT - Buffer.byteLength(initial, 'utf8') - reserveBytes) / lineBytes);
  assert.ok(copies > 0);
  writeFileSync(path, initial + deliveredLine.repeat(copies), 'utf8');
  const remaining = OUTBOX_TOTAL_LIMIT - statSync(path).size;
  assert.ok(remaining >= reserveBytes && remaining < reserveBytes + lineBytes);
  assert.equal(new DurableOutbox(path).recover().delivered[0]?.delivery_id, ack.delivery_id);
  return { remaining, ackId: ack.delivery_id, deliveredLineBytes: lineBytes };
}

test('AC01 outbox append rejects crossing aggregate size cap without changes', () => {
  withOutbox((path) => {
    const nextPath = path + '.next';
    new DurableOutbox(nextPath).enqueueEvents(eventsRequest());
    const eventBytes = statSync(nextPath).size;
    const { remaining } = denseOutbox(path, 0);
    assert.ok(eventBytes > remaining);
    const before = readFileSync(path);
    assert.throws(() => new DurableOutbox(path).enqueueEvents(eventsRequest()),
      (error: unknown) => error instanceof DurableOutboxError && error.code === 'outbox_invalid');
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).size, before.byteLength);
    assert.equal(new DurableOutbox(path).recover().pending.length, 0);
  });
});

test('AC02 outbox append within remaining aggregate size recovers on restart', () => {
  withOutbox((path) => {
    const nextPath = path + '.next';
    new DurableOutbox(nextPath).enqueueEvents(eventsRequest());
    const eventBytes = statSync(nextPath).size;
    const { remaining, ackId } = denseOutbox(path, eventBytes);
    assert.ok(remaining >= eventBytes);
    const eventsDelivery = new DurableOutbox(path).enqueueEvents(eventsRequest());
    assert.ok(statSync(path).size <= OUTBOX_TOTAL_LIMIT);
    const recovered = new DurableOutbox(path).recover();
    assert.deepEqual(recovered.pending.map(item => item.delivery_id), [eventsDelivery.delivery_id]);
    assert.deepEqual(recovered.delivered.map(item => item.delivery_id), [ackId]);
    const before = readFileSync(path);
    assert.equal(new DurableOutbox(path).enqueueEvents(eventsRequest()).delivery_id, eventsDelivery.delivery_id);
    assert.deepEqual(readFileSync(path), before);
  });
});

test('AC03 existing oversized outbox refuses new append and preserves bytes', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    outbox.enqueueAck(ackRequest());
    const prefix = readFileSync(path);
    truncateSync(path, OUTBOX_TOTAL_LIMIT + 1);
    const size = statSync(path).size;
    assert.throws(() => outbox.enqueueEvents(eventsRequest()),
      (error: unknown) => error instanceof DurableOutboxError && error.code === 'outbox_invalid');
    assert.equal(statSync(path).size, size);
    assert.deepEqual(readFileSync(path).subarray(0, prefix.length), prefix);
    assert.throws(() => new DurableOutbox(path).recover(),
      (error: unknown) => error instanceof DurableOutboxError && error.code === 'outbox_invalid');
  });
});


test('AC01 outbox post-fstat growth rejects within bounded bytes', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    outbox.enqueueAck(ackRequest());
    const canary = readFileSync(path);
    assert.ok(canary.length > 0 && canary.length < OUTBOX_TOTAL_LIMIT);
    const original = fs.readSync;
    let injected = false;
    let requested = 0;
    let readBytes = 0;
    try {
      fs.readSync = ((fd: number, buffer: Buffer, offset: number,
        length: number, position: number | null) => {
        if (!injected) {
          // fstat has already accepted this regular descriptor.
          truncateSync(path, OUTBOX_TOTAL_LIMIT + 1);
          injected = true;
        }
        requested += length;
        const count = original(fd, buffer, offset, length, position);
        readBytes += count;
        return count;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      assert.throws(() => outbox.recover(), (error: unknown) =>
        error instanceof DurableOutboxError && error.code === 'outbox_invalid');
    } finally {
      fs.readSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(readBytes, OUTBOX_TOTAL_LIMIT + 1);
    assert.ok(requested <= OUTBOX_TOTAL_LIMIT + 1);
    const grown = readFileSync(path);
    assert.equal(grown.length, OUTBOX_TOTAL_LIMIT + 1);
    assert.deepEqual(grown.subarray(0, canary.length), canary);
    // Rejecting recovery cannot replay a truncated prefix or append a record.
    assert.throws(() => outbox.enqueueEvents(eventsRequest()),
      (error: unknown) => error instanceof DurableOutboxError && error.code === 'outbox_invalid');
    assert.deepEqual(readFileSync(path), grown);
  });
});


/**
 * Exercise the literal byte boundaries required by #512.
 * The NDJSON remains canonical: padding is inside a valid event summary.
 */
function eventRequestWithExtraSummaryBytes(extra: number) {
  assert.ok(Number.isInteger(extra) && extra >= 0 && extra < 1024);
  return {
    ...eventsRequest(),
    events: [event({
      evidence: {
        code: 'accepted',
        summary: 'Order accepted by runner' + 'x'.repeat(extra),
        ref: null,
      },
    })],
  };
}

test('AC01 outbox rejects one byte over exact aggregate limit', () => {
  withOutbox((path) => {
    const probePath = path + '.probe';
    new DurableOutbox(probePath).enqueueEvents(eventsRequest());
    const baseBytes = statSync(probePath).size;
    const { remaining, deliveredLineBytes } = denseOutbox(path, baseBytes);
    const extra = remaining - baseBytes + 1;
    assert.ok(extra > 0 && extra <= deliveredLineBytes);
    const overByOne = eventRequestWithExtraSummaryBytes(extra);

    const actualPath = path + '.exact-probe';
    new DurableOutbox(actualPath).enqueueEvents(overByOne);
    assert.equal(statSync(actualPath).size, remaining + 1);

    const before = readFileSync(path);
    assert.throws(() => new DurableOutbox(path).enqueueEvents(overByOne),
      (error: unknown) => error instanceof DurableOutboxError && error.code === 'outbox_invalid');
    assert.equal(statSync(path).size, OUTBOX_TOTAL_LIMIT - remaining);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(new DurableOutbox(path).recover().pending.length, 0);
  });
});

test('AC02 outbox append fills exact aggregate limit and survives restart', () => {
  withOutbox((path) => {
    const probePath = path + '.probe';
    new DurableOutbox(probePath).enqueueEvents(eventsRequest());
    const baseBytes = statSync(probePath).size;
    const { remaining, ackId, deliveredLineBytes } = denseOutbox(path, baseBytes);
    const extra = remaining - baseBytes;
    assert.ok(extra >= 0 && extra < deliveredLineBytes);
    const exactlyFits = eventRequestWithExtraSummaryBytes(extra);

    const actualPath = path + '.exact-probe';
    new DurableOutbox(actualPath).enqueueEvents(exactlyFits);
    assert.equal(statSync(actualPath).size, remaining);

    const delivery = new DurableOutbox(path).enqueueEvents(exactlyFits);
    assert.equal(statSync(path).size, OUTBOX_TOTAL_LIMIT);
    const recovered = new DurableOutbox(path).recover();
    assert.deepEqual(recovered.pending.map(x => x.delivery_id), [delivery.delivery_id]);
    assert.deepEqual(recovered.delivered.map(x => x.delivery_id), [ackId]);
    const before = readFileSync(path);
    assert.equal(new DurableOutbox(path).enqueueEvents(exactlyFits).delivery_id, delivery.delivery_id);
    assert.deepEqual(readFileSync(path), before);
  });
});

/** The fake closes the real descriptor first to avoid leaking file handles. */
function withSyntheticCloseFailure(run: () => void): void {
  const realClose = fs.closeSync;
  fs.closeSync = ((descriptor: number) => {
    realClose(descriptor);
    throw Object.assign(new Error('synthetic close failure'), { code: 'EIO' });
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs.closeSync = realClose;
    syncBuiltinESMExports();
  }
}

test('AC01 outbox close failure returns typed IO error', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    withSyntheticCloseFailure(() => {
      assert.throws(() => outbox.enqueueAck(ackRequest()), (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_io');
        assert.equal((error.cause as { code?: string })?.code, 'EIO');
        return true;
      });
    });
    // A reported failure does not imply the preceding append/fsync was rolled back.
    assert.equal(outbox.recover().pending.length, 1);
    withSyntheticCloseFailure(() => {
      assert.throws(() => outbox.recover(), (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_io');
        assert.equal((error.cause as { code?: string })?.code, 'EIO');
        return true;
      });
    });
  });
});

test('AC02 outbox close failure preserves earlier invalid error', () => {
  withOutbox((path) => {
    writeFileSync(path, '{"not_an_outbox_record":true}\n', 'utf8');
    const before = readFileSync(path);
    withSyntheticCloseFailure(() => {
      assert.throws(() => new DurableOutbox(path).recover(), (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_invalid');
        assert.notEqual((error.cause as { code?: string } | undefined)?.code, 'EIO');
        return true;
      });
    });
    assert.deepEqual(readFileSync(path), before);
  });
});

test('AC03 outbox close guard maintains recovery and idempotency', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const first = outbox.enqueueAck(ackRequest());
    assert.equal(outbox.enqueueAck(ackRequest()).delivery_id, first.delivery_id);
    assert.equal(outbox.recover().pending[0]?.delivery_id, first.delivery_id);
    outbox.markDelivered(first.delivery_id);
    assert.deepEqual(new DurableOutbox(path).recover().pending, []);
    assert.equal(new DurableOutbox(path).recover().delivered[0]?.delivery_id, first.delivery_id);
  });
});

/** Use only synthetic failures. Close the real descriptor before throwing EIO. */
function withSyntheticPersistAndCloseFailures(
  operation: 'append' | 'fsync',
  run: (primary: Error, closed: () => number) => void,
  fsyncCode: 'EIO' | 'ENOSPC' = 'EIO',
): void {
  const originalAppend = fs.appendFileSync;
  const originalFsync = fs.fsyncSync;
  const originalClose = fs.closeSync;
  const primary = Object.assign(
    new Error(operation === 'append' ? 'synthetic append primary' : 'synthetic fsync primary'),
    { code: operation === 'append' ? 'ENOSPC' : fsyncCode },
  );
  let closeCount = 0;
  try {
    if (operation === 'append') {
      fs.appendFileSync = (() => { throw primary; }) as typeof fs.appendFileSync;
    } else {
      fs.fsyncSync = (() => { throw primary; }) as typeof fs.fsyncSync;
    }
    fs.closeSync = ((descriptor: number) => {
      originalClose(descriptor);
      closeCount += 1;
      throw Object.assign(new Error('synthetic secondary close'), { code: 'EIO' });
    }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    run(primary, () => closeCount);
  } finally {
    fs.appendFileSync = originalAppend;
    fs.fsyncSync = originalFsync;
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
  }
}

test('AC01 outbox append ENOSPC plus close EIO preserves primary', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    withSyntheticPersistAndCloseFailures('append', (primary, closed) => {
      assert.throws(() => outbox.enqueueAck(ackRequest()), (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_io');
        assert.strictEqual(error.cause, primary);
        assert.equal((error.cause as { code?: string })?.code, 'ENOSPC');
        return true;
      });
      assert.equal(closed(), 1);
    });
    assert.equal(statSync(path).size, 0);
    assert.deepEqual(outbox.recover().pending, []);
    assert.deepEqual(outbox.recover().delivered, []);
  });
});

/** Share one failure assertion across both fsync error codes; no duplicated scenario. */
function assertFsyncFailurePreservesPrimary(code: 'EIO' | 'ENOSPC'): void {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    withSyntheticPersistAndCloseFailures('fsync', (primary, closed) => {
      assert.throws(() => outbox.enqueueAck(ackRequest()), (error: unknown) => {
        assert.ok(error instanceof DurableOutboxError);
        assert.equal(error.code, 'outbox_io');
        assert.strictEqual(error.cause, primary);
        assert.equal((error.cause as { code?: string })?.code, code);
        return true;
      });
      assert.equal(closed(), 1);
    }, code);
    // fsync failure does not imply rollback: the append can be durable.
    const recovered = outbox.recover();
    assert.equal(recovered.pending.length, 1);
    assert.equal(recovered.delivered.length, 0);
    const before = readFileSync(path);
    assert.equal(outbox.enqueueAck(ackRequest()).delivery_id, recovered.pending[0]?.delivery_id);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(new DurableOutbox(path).recover().pending.length, 1);
  });
}

test('AC02 outbox fsync EIO plus close EIO preserves primary', () => {
  assertFsyncFailurePreservesPrimary('EIO');
});

test('AC02 outbox fsync ENOSPC plus close EIO preserves primary', () => {
  assertFsyncFailurePreservesPrimary('ENOSPC');
});
