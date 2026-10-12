import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableOutbox, DurableOutboxError } from '../src/outbox.ts';

function withOutbox(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-enoent-'));
  try {
    run(join(directory, 'outbox.ndjson'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function ackRequest() {
  return {
    version: 1,
    order_id: '22222222-2222-7222-8222-222222222222',
    runner_id: '11111111-1111-7111-8111-111111111111',
    fingerprint: 'a'.repeat(64),
  };
}

/** Inject ENOENT after successful open and always restore native fs bindings. */
function withReadEnoent(run: () => void): void {
  const nativeRead = fs.readSync;
  fs.readSync = (() => {
    throw Object.assign(new Error('Synthetic ENOENT after open'), { code: 'ENOENT' });
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs.readSync = nativeRead;
    syncBuiltinESMExports();
  }
}

function assertTypedReadFailure(outbox: DurableOutbox): void {
  assert.throws(() => outbox.recover(), (error: unknown) => {
    assert.ok(error instanceof DurableOutboxError);
    assert.equal(error.code, 'outbox_io');
    assert.equal((error.cause as { code?: string } | undefined)?.code, 'ENOENT');
    return true;
  });
}

test('AC01 read ENOENT after successful open fails closed', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    outbox.enqueueAck(ackRequest());
    const before = readFileSync(path);
    assert.ok(before.length > 0);
    withReadEnoent(() => assertTypedReadFailure(outbox));
    assert.deepEqual(readFileSync(path), before);
  });
});

test('AC02 missing outbox is still an empty queue', () => {
  withOutbox((path) => {
    assert.equal(existsSync(path), false);
    assert.deepEqual(new DurableOutbox(path).recover(), { pending: [], delivered: [] });
    assert.equal(existsSync(path), false);
  });
});

test('AC03 recovery after read error preserves pending delivery and idempotency', () => {
  withOutbox((path) => {
    const outbox = new DurableOutbox(path);
    const delivery = outbox.enqueueAck(ackRequest());
    const before = readFileSync(path);
    withReadEnoent(() => assertTypedReadFailure(outbox));
    const recovered = new DurableOutbox(path).recover();
    assert.equal(recovered.pending.length, 1);
    assert.equal(recovered.pending[0]?.delivery_id, delivery.delivery_id);
    assert.equal(recovered.delivered.length, 0);
    assert.equal(outbox.enqueueAck(ackRequest()).delivery_id, delivery.delivery_id);
    assert.deepEqual(readFileSync(path), before);
  });
});
