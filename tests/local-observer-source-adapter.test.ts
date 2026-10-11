import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capacitySnapshot } from '../src/result.ts';
import { heartbeatHealth, parseRunnerHeartbeat } from '../src/runner.ts';
import { projectSyntheticObserverFromExports } from '../src/local-observer-source-adapter.ts';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

const ID = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
const BASE = 1_700_000_100;
const SECRET = 'private-session-sentinel-123';

function identity(overrides: Record<string, unknown> = {}) {
  return {version: 1, runner_id: ID, protocol_version: 1, runtime: 'node',
    runtime_version: '0.1.5', platform: 'macos-arm64', location: 'local',
    capabilities: ['git'], max_parallel: 4, ...overrides};
}
function heartbeat(overrides: Record<string, unknown> = {}) {
  return {version: 1, runner_id: ID, sequence: 7, observed_at: BASE,
    status: 'ready', capacity: {max: 4, active: 1},
    active_sessions: [SECRET], ...overrides};
}
function queue(overrides: Record<string, unknown> = {}) {
  return {version: 1, runner_id: ID, observed_at: BASE,
    queued_orders: 17, ...overrides};
}
function fixture(now = BASE + 30) {
  const hb = heartbeat();
  return {snapshot: capacitySnapshot(identity(), hb, queue(), now), hb};
}

test('AC01 synthetic capacity export renders only synthetic UNKNOWN observer view', () => {
  const {snapshot, hb} = fixture();
  const health = heartbeatHealth(parseRunnerHeartbeat(hb), BASE + 30);
  assert.equal(health, 'healthy');
  assert.equal(snapshot.runner_status, 'ready');
  assert.equal(snapshot.available, 3);
  assert.equal(snapshot.queued_orders, 17);
  const dto = projectSyntheticObserverFromExports(snapshot, hb, BASE + 30);
  const html = renderLocalObserverHtml(dto);
  assert.equal(dto.version, 1);
  assert.equal(dto.provenance, 'synthetic');
  assert.equal(dto.freshness, 'UNKNOWN');
  assert.equal(dto.observed_at, null);
  assert.deepEqual(dto.capacity, {total: 4, available: null});
  assert.deepEqual(dto.queue, {pending: null, blocked: null});
  assert.equal(dto.runners.length, 1);
  assert.match(dto.runners[0].id, /^runner-[0-9a-f]{12}$/);
  assert.equal(dto.runners[0].status, 'UNKNOWN');
  assert.equal(dto.runners[0].last_outcome, 'UNKNOWN');
  assert.match(html, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.ok(!html.includes(ID));
  assert.ok(!html.includes('READY (reportado)'));
});

test('AC02 stale offline future and identity drift can never become FRESH', () => {
  for (const age of [90, 91, 300, 301]) {
    const now = BASE + age;
    const {snapshot, hb} = fixture(now);
    const dto = projectSyntheticObserverFromExports(snapshot, hb, now);
    assert.equal(dto.freshness, 'UNKNOWN');
    assert.equal(dto.provenance, 'synthetic');
    assert.equal(dto.capacity.available, null);
    assert.deepEqual(dto.queue, {pending: null, blocked: null});
    assert.equal(dto.runners[0].status, 'UNKNOWN');
    const health = heartbeatHealth(parseRunnerHeartbeat(hb), now);
    assert.equal(health, age <= 90 ? 'healthy' : age <= 300 ? 'stale' : 'offline');
    assert.equal(snapshot.available, age <= 90 ? 3 : 0);
  }
  const {snapshot, hb} = fixture();
  for (const [candidate, beat, now] of [
    [snapshot, hb, BASE - 1],
    [{...snapshot, runner_id: OTHER}, hb, BASE + 30],
    [snapshot, heartbeat({runner_id: OTHER}), BASE + 30],
    [{...snapshot, heartbeat_sequence: 8}, hb, BASE + 30],
    [{...snapshot, available: 4}, hb, BASE + 30],
    [{...snapshot, queued_orders: -1}, hb, BASE + 30],
  ] as const) {
    const dto = projectSyntheticObserverFromExports(candidate, beat, now);
    assert.equal(dto.freshness, 'UNKNOWN');
    assert.equal(dto.capacity.available, null);
    assert.deepEqual(dto.runners, []);
  }
  assert.deepEqual(projectSyntheticObserverFromExports(snapshot, hb, Number.NaN).runners, []);
  assert.deepEqual(projectSyntheticObserverFromExports(snapshot, null, BASE + 30).runners, []);
});

test('AC03 private sessions evidence UUID and local queue never leak', () => {
  const {snapshot, hb} = fixture();
  const dto = projectSyntheticObserverFromExports(snapshot, hb, BASE + 30);
  const html = renderLocalObserverHtml(dto);
  for (const privateValue of [SECRET, ID, 'active_sessions', 'private-evidence-sentinel',
    'token=private-sentinel', 'ExecutionEvidence', '"queued_orders":17']) {
    assert.ok(!JSON.stringify(dto).includes(privateValue), privateValue);
    assert.ok(!html.includes(privateValue), privateValue);
  }
  assert.equal(dto.queue.pending, null);
  assert.equal(dto.queue.blocked, null);
  assert.equal(dto.runners[0].last_outcome, 'UNKNOWN');
  const poisoned = {...snapshot, evidence: {summary: 'private-evidence-sentinel'}};
  assert.deepEqual(projectSyntheticObserverFromExports(poisoned, hb, BASE + 30).runners, []);
  assert.deepEqual(projectSyntheticObserverFromExports(snapshot, {...hb, token: 'secret'}, BASE + 30).runners, []);
  const hostileHeartbeat = {...hb};
  Object.defineProperty(hostileHeartbeat, 'status', {
    enumerable: true, get() {throw new Error('private-evidence-sentinel');},
  });
  assert.deepEqual(projectSyntheticObserverFromExports(snapshot, hostileHeartbeat, BASE + 30).runners, []);
});

test('AC04 adapter is a pure no-IO no-command authority-neutral fixture function', () => {
  const {snapshot, hb} = fixture();
  const originalSnapshot = JSON.stringify(snapshot);
  const originalHeartbeat = JSON.stringify(hb);
  const first = projectSyntheticObserverFromExports(snapshot, hb, BASE + 30);
  const second = projectSyntheticObserverFromExports(snapshot, hb, BASE + 30);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(snapshot), originalSnapshot);
  assert.equal(JSON.stringify(hb), originalHeartbeat);
  assert.deepEqual(Object.keys(first).sort(),
    ['version', 'provenance', 'freshness', 'observed_at', 'capacity', 'queue', 'runners'].sort());
  assert.deepEqual(Object.keys(first.runners[0]).sort(),
    ['id', 'status', 'reason', 'heartbeat_at', 'last_outcome'].sort());
  const source = readFileSync(new URL('../src/local-observer-source-adapter.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:fs|net|http|https|child_process|worker_threads)['"]/);
  assert.doesNotMatch(source, /\b(?:fetch|listen|spawn|exec|writeFile|readFile|GITHUB_TOKEN)\s*\(/);
  assert.doesNotMatch(renderLocalObserverHtml(first), /<\s*(?:script|form|button|iframe)\b/i);
});
