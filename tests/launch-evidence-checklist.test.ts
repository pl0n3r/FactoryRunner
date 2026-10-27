import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateLaunchEvidenceChecklist,
  LAUNCH_EVIDENCE_GATES,
  MAX_EVIDENCE_AGE_MS,
} from '../src/launch-evidence-checklist.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2026-10-27T12:00:00.000Z';
const proof = (gate: (typeof LAUNCH_EVIDENCE_GATES)[number]) => ({
  gate,
  source: 'artifact://fixtures/' + gate,
  source_sha: SHA,
  observed_at: '2026-10-26T12:00:00.000Z',
  status: 'PASS',
});
const fixtures = () => LAUNCH_EVIDENCE_GATES.map(proof);
const check = (proofs: unknown = fixtures(), source_sha: unknown = SHA) =>
  evaluateLaunchEvidenceChecklist({ version: 1, source_sha, proofs }, NOW);

test('all eight offline sources with dates and PASS satisfy inventory, never permit live', () => {
  const result = check();
  assert.equal(result.complete_offline, true);
  assert.equal(result.mode, 'offline_inventory');
  assert.equal(result.readiness, 'UNKNOWN');
  assert.equal(result.go_no_go, 'NO_GO');
  assert.equal(result.live_authorized, false);
  assert.deepEqual(result.missing_gates, []);
  assert.deepEqual(result.stale_gates, []);
  assert.deepEqual(result.nonpassing_gates, []);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(check([...fixtures()].reverse()), result);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.missing_gates));
});

test('missing or duplicate evidence is never a complete inventory', () => {
  const missing = check(fixtures().slice(1));
  assert.equal(missing.complete_offline, false);
  assert.deepEqual(missing.missing_gates, ['accessibility']);
  assert.equal(missing.readiness, 'UNKNOWN');
  assert.throws(() => check([...fixtures().slice(1), proof('performance_p95')]), TypeError);
  assert.throws(() => check([...fixtures(), proof('accessibility')]), TypeError);
});

test('stale and future timestamps fail closed with an injected clock', () => {
  const stale = fixtures();
  stale[0] = { ...stale[0], observed_at: '2026-10-19T12:00:00.000Z' };
  assert.deepEqual(check(stale).stale_gates, ['accessibility']);
  assert.equal(check(stale).complete_offline, false);
  const future = fixtures();
  future[1] = { ...future[1], observed_at: '2026-10-28T12:00:00.000Z' };
  assert.deepEqual(check(future).stale_gates, ['performance_p95']);
  assert.equal(check(future).complete_offline, false);
  const boundary = fixtures();
  boundary[0] = { ...boundary[0], observed_at: new Date(Date.parse(NOW) - MAX_EVIDENCE_AGE_MS).toISOString() };
  assert.equal(check(boundary).complete_offline, true);
});

test('FAIL/UNKNOWN on any gate is nonpassing even with complete metadata', () => {
  const rows = fixtures();
  rows[2] = { ...rows[2], status: 'FAIL' };
  rows[3] = { ...rows[3], status: 'UNKNOWN' };
  const report = check(rows);
  assert.equal(report.complete_offline, false);
  assert.deepEqual(report.nonpassing_gates, ['security_permissions', 'security_sast']);
  assert.equal(report.live_authorized, false);
});

test('strict source, date, SHA, schema and unknown fields reject ambiguous inputs', () => {
  const rows = fixtures();
  assert.throws(() => check([{ ...rows[0], source: '' }]), TypeError);
  assert.throws(() => check([{ ...rows[0], source: 'https://example.test?token=secret' }]), TypeError);
  assert.throws(() => check([{ ...rows[0], observed_at: '2026-02-30T12:00:00.000Z' }]), TypeError);
  assert.throws(() => check([{ ...rows[0], observed_at: null }]), TypeError);
  assert.throws(() => check([{ ...rows[0], source_sha: 'a'.repeat(40) }]), TypeError);
  assert.throws(() => check([{ ...rows[0], status: 'READY' }]), TypeError);
  assert.throws(() => check([{ ...rows[0], gate: 'made_up' }]), TypeError);
  assert.throws(() => check([{ ...rows[0], credential: 'never echo' }]), TypeError);
  assert.throws(() => check(rows, 'HEAD'), TypeError);
  assert.throws(() => evaluateLaunchEvidenceChecklist({ version: 1, source_sha: SHA, proofs: rows, live_authorized: true }, NOW), TypeError);
  assert.throws(() => evaluateLaunchEvidenceChecklist({ version: 1, source_sha: SHA, proofs: rows }, 'yesterday'), TypeError);
});

test('getters, inherited, nonenumerable or symbol keys cannot smuggle a proof', () => {
  const valid = proof('accessibility');
  const accessor = Object.defineProperty({ ...valid }, 'status', {
    enumerable: true, get() { throw new Error('must not read getter'); },
  });
  assert.throws(() => check([accessor]), TypeError);
  assert.throws(() => check([Object.create(valid)]), TypeError);
  assert.throws(() => check([Object.defineProperty({ ...valid }, 'hidden', { value: 'x' })]), TypeError);
  assert.throws(() => check([{ ...valid, [Symbol('hidden')]: 'x' }]), TypeError);
  const holey = new Array(LAUNCH_EVIDENCE_GATES.length);
  holey[0] = valid;
  assert.throws(() => check(holey), TypeError);
  const withAccessorIndex = fixtures();
  Object.defineProperty(withAccessorIndex, '0', {
    enumerable: true, get() { throw new Error('must not read index getter'); },
  });
  assert.throws(() => check(withAccessorIndex), TypeError);
});

test('no network, I/O or clock read; source only binds inventory fingerprint', () => {
  const fetchOriginal = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('network forbidden'); }) as typeof fetch;
  try {
    const first = check();
    const changed = fixtures();
    changed[0] = { ...changed[0], source: 'evidence://fixtures/alternate' };
    const second = check(changed);
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(calls, 0);
    assert.equal('source' in first, false);
    assert.equal(first.live_authorized, false);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
