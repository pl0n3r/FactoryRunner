import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFLINE_GATES, evaluateOfflinePreflight } from '../src/go-live-preflight.ts';

const sha = '38c018af56824236b42cb57b49c5741903dbfe26';
const allProofs = () => OFFLINE_GATES.map((gate) => ({ gate, source_sha: sha, status: 'PASS' }));

test('all offline proofs enable preparation but never operation', () => {
  const complete = evaluateOfflinePreflight({ version: 1, source_sha: sha, proofs: allProofs() });
  assert.equal(complete.prepared_offline, true);
  assert.equal(complete.mode, 'offline_preflight');
  assert.equal(complete.readiness, 'UNKNOWN');
  assert.equal(complete.live_authorized, false);
  assert.deepEqual(complete.missing_gates, []);
  assert.deepEqual(complete.nonpassing_gates, []);
  assert.match(complete.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(complete));
  assert.ok(Object.isFrozen(complete.missing_gates));
  assert.deepEqual(evaluateOfflinePreflight({ version: 1, source_sha: sha, proofs: [...allProofs()].reverse() }), complete);
});

test('missing, stale and failed offline proof are fail closed', () => {
  const omitted = allProofs().slice(1);
  const missing = evaluateOfflinePreflight({ version: 1, source_sha: sha, proofs: omitted });
  assert.equal(missing.prepared_offline, false);
  assert.deepEqual(missing.missing_gates, ['branch_protection']);
  assert.equal(missing.live_authorized, false);
  const offline = allProofs();
  offline[0] = { gate: 'branch_protection', source_sha: sha, status: 'UNKNOWN' };
  const failed = evaluateOfflinePreflight({ version: 1, source_sha: sha, proofs: offline });
  assert.equal(failed.prepared_offline, false);
  assert.deepEqual(failed.nonpassing_gates, ['branch_protection']);
  assert.equal(failed.readiness, 'UNKNOWN');
});

test('ambiguous, spoofed or invalid evidence never accepted', () => {
  const good = allProofs();
  const call = (proofs: unknown, source_sha: unknown = sha) => evaluateOfflinePreflight({ version: 1, source_sha, proofs });
  assert.throws(() => call([...good, good[0]]), TypeError);
  assert.throws(() => call([{ ...good[0], gate: 'secret' }]), TypeError);
  assert.throws(() => call([{ ...good[0], source_sha: 'a'.repeat(40) }]), TypeError);
  assert.throws(() => call([{ ...good[0], status: 'READY' }]), TypeError);
  assert.throws(() => call(good, 'HEAD'), TypeError);
  assert.throws(() => evaluateOfflinePreflight({ version: 1, source_sha: sha, proofs: good, live_authorized: true }), TypeError);
  assert.throws(() => call([{ ...good[0], payload: 'token' }]), TypeError);
  assert.throws(() => call([Object.defineProperty({}, 'gate', { enumerable: true, get() { throw new Error('getter must not run'); } })]), TypeError);
  assert.throws(() => call([Object.create({ ...good[0] })]), TypeError);
  assert.throws(() => call([Object.defineProperty({ ...good[0] }, 'status', { enumerable: false, value: 'PASS' })]), TypeError);
  assert.throws(() => call('not array'), TypeError);
});

test('reports cannot elevate live authority regardless of gate combinations', () => {
  for (const status of ['PASS', 'FAIL', 'UNKNOWN'] as const) {
    const report = evaluateOfflinePreflight({
      version: 1, source_sha: sha,
      proofs: OFFLINE_GATES.map((gate) => ({ gate, source_sha: sha, status })),
    });
    assert.equal(report.live_authorized, false);
    assert.equal(report.readiness, 'UNKNOWN');
  }
});
