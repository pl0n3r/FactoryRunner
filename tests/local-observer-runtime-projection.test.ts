import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {capacitySnapshot} from '../src/result.ts';
import {projectInProcessObserverCandidate} from '../src/local-observer-runtime-projection.ts';

const ID = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
const BASE = 1_700_000_100;
const PRIVATE = 'private-session-sentinel-123';

function identity() {
  return {version: 1, runner_id: ID, protocol_version: 1,
    runtime: 'node', runtime_version: '0.1.5', platform: 'macos-arm64',
    location: 'local', capabilities: ['git'], max_parallel: 4};
}
function hb(overrides: Record<string, unknown> = {}) {
  return {version: 1, runner_id: ID, sequence: 7, observed_at: BASE,
    status: 'ready', capacity: {max: 4, active: 1},
    active_sessions: [PRIVATE], ...overrides};
}
function queue() {
  return {version: 1, runner_id: ID, observed_at: BASE, queued_orders: 17};
}
function input(now = BASE + 30, override: Record<string, unknown> = {}) {
  const beat = hb(override);
  return {beat, snap: capacitySnapshot(identity(), beat, queue(), now)};
}
const view = (snap: unknown, beat: unknown, now: unknown, previous?: unknown) =>
  projectInProcessObserverCandidate(snap, beat, now, previous);

test('AC01 consistent fresh candidate reports bounded metadata only', () => {
  for (const age of [0, 30, 90]) {
    const {snap, beat} = input(BASE + age);
    const first = view(snap, beat, BASE + age, 6);
    const second = view(snap, beat, BASE + age, 6);
    assert.deepEqual(first, second);
    assert.equal(first.version, 1);
    assert.equal(first.kind, 'in_process_candidate');
    assert.equal(first.sample_freshness, 'FRESH');
    assert.equal(first.readiness, 'UNKNOWN');
    assert.equal(first.runner_status, 'ready');
    assert.equal(first.heartbeat_age_seconds, age);
    assert.equal(first.capacity.total, 4);
    assert.equal(first.capacity.available, null);
    assert.deepEqual(first.queue, {pending: null, blocked: null});
    assert.equal(first.last_outcome, 'UNKNOWN');
    assert.match(first.runner_alias ?? '', /^runner-[0-9a-f]{12}$/);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.capacity), true);
    assert.equal(Object.isFrozen(first.queue), true);
  }
  const {snap, beat} = input();
  assert.equal(view(snap, beat, BASE + 30).sample_freshness, 'FRESH');
  const draining = hb({status: 'draining'});
  const drainSnap = capacitySnapshot(identity(), draining, queue(), BASE + 30);
  assert.equal(view(drainSnap, draining, BASE + 30).readiness, 'UNKNOWN');
  assert.equal(view(drainSnap, draining, BASE + 30).capacity.available, null);
});

test('AC02 absolute age future sequence and mismatched identity fail closed', () => {
  for (const [age, freshness] of [
    [91, 'STALE'], [300, 'STALE'], [301, 'OFFLINE'],
  ] as const) {
    const {snap, beat} = input(BASE + age);
    const v = view(snap, beat, BASE + age, 6);
    assert.equal(v.sample_freshness, freshness, String(age));
    assert.equal(v.readiness, 'UNKNOWN');
    assert.equal(v.capacity.available, null);
    assert.equal(v.runner_alias, null);
    assert.equal(v.runner_status, 'UNKNOWN');
    assert.equal(v.heartbeat_age_seconds, age);
  }
  const {snap, beat} = input();
  const invalid: Array<[unknown, unknown, unknown, unknown?]> = [
    [snap, beat, BASE - 1],
    [snap, beat, BASE + 30, 7],
    [snap, beat, BASE + 30, 8],
    [snap, beat, BASE + 30, -1],
    [{...snap, runner_id: OTHER}, beat, BASE + 30],
    [{...snap, heartbeat_sequence: 8}, beat, BASE + 30],
    [{...snap, available: 4}, beat, BASE + 30],
    [{...snap, dispatchable_orders: 999}, beat, BASE + 30],
    [snap, {...beat, runner_id: OTHER}, BASE + 30],
    [snap, beat, Number.NaN],
    [snap, beat, '1700000130'],
    [snap, null, BASE + 30],
    [null, beat, BASE + 30],
  ];
  for (const [s, h, now, previous] of invalid) {
    const v = view(s, h, now, previous);
    assert.equal(v.sample_freshness, 'UNKNOWN');
    assert.equal(v.readiness, 'UNKNOWN');
    assert.equal(v.runner_alias, null);
    assert.equal(v.capacity.total, null);
    assert.equal(v.heartbeat_age_seconds, null);
  }
});

test('AC03 no sensitive fields or IO/command authority can escape', () => {
  const {snap, beat} = input();
  const a = JSON.stringify(snap);
  const b = JSON.stringify(beat);
  const v = view(snap, beat, BASE + 30, 6);
  assert.deepEqual(Object.keys(v).sort(), [
    'version','kind','sample_freshness','readiness','runner_alias',
    'runner_status','heartbeat_age_seconds','capacity','queue','last_outcome',
  ].sort());
  assert.deepEqual(Object.keys(v.capacity), ['total','available']);
  assert.deepEqual(Object.keys(v.queue), ['pending','blocked']);
  assert.equal(JSON.stringify(snap), a);
  assert.equal(JSON.stringify(beat), b);
  for (const secret of [ID, PRIVATE, 'active_sessions', 'queued_orders',
    'dispatchable_orders', 'evidence', 'token', 'order_id', 'macos-arm64']) {
    assert.ok(!JSON.stringify(v).includes(secret), secret);
  }
  const poisoned = [
    {...snap, evidence: 'private-evidence-sentinel'},
    Object.defineProperty({...snap}, 'available', {enumerable: true,
      get() {throw Error('private-evidence-sentinel');}}),
    Object.assign(Object.create(null), {...snap, token: 'secret'}),
  ];
  for (const s of poisoned) assert.equal(view(s, beat, BASE + 30).sample_freshness, 'UNKNOWN');
  const foreign = Object.defineProperty({...beat}, 'status',
    {enumerable: true, get() {throw Error('PRIVATE');}});
  assert.equal(view(snap, foreign, BASE + 30).sample_freshness, 'UNKNOWN');
  assert.equal(view(snap, {...beat, token: 'secret'}, BASE + 30).sample_freshness, 'UNKNOWN');
  const source = readFileSync(new URL('../src/local-observer-runtime-projection.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:fs|net|http|https|child_process|worker_threads)['"]/);
  assert.doesNotMatch(source, /\b(?:fetch|listen|spawn|exec|writeFile|readFile|setInterval|GITHUB_TOKEN)\s*\(/);
  assert.doesNotMatch(source, /\b(?:process\.env|active_sessions\s*:\s*\[PRIVATE\])/);
});
