import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capacitySnapshot } from '../src/result.ts';
import { observeSyntheticRunnerSource } from '../src/observer-synthetic-source.ts';

const ID = '11111111-1111-7111-8111-111111111111';
const SECOND = '22222222-2222-7222-8222-222222222222';
const BASE = 1_700_000_100;
const SECRET = 'private-credential-token-sentinel';

function fixture() {
  const identity = {version: 1, runner_id: ID, protocol_version: 1, runtime: 'node',
    runtime_version: '0.1.0', platform: 'linux-arm64', location: 'local',
    capabilities: ['git'], max_parallel: 4};
  const heartbeat = {version: 1, runner_id: ID, sequence: 7, observed_at: BASE,
    status: 'ready', capacity: {max: 4, active: 1}, active_sessions: [SECRET]};
  const queue = {version: 1, runner_id: ID, observed_at: BASE, queued_orders: 5};
  const snapshot = capacitySnapshot(identity, heartbeat, queue, BASE + 15);
  return {version: 1, kind: 'synthetic', snapshot, heartbeat};
}

const EMPTY = {version: 1, provenance: 'synthetic', freshness: 'UNKNOWN',
  observed_at: null, capacity: {total: null, available: null},
  queue: {pending: null, blocked: null}, runners: []};

test('AC-01 synthetic-only observer reports non-authoritative capacity and runner state', () => {
  const result = observeSyntheticRunnerSource(fixture(), BASE + 15);
  assert.equal(result.version, 1);
  assert.equal(result.provenance, 'synthetic');
  assert.equal(result.freshness, 'UNKNOWN');
  assert.equal(result.observed_at, null);
  assert.deepEqual(result.capacity, {total: 4, available: null});
  assert.deepEqual(result.queue, {pending: null, blocked: null});
  assert.equal(result.runners.length, 1);
  assert.match(result.runners[0].id, /^runner-[0-9a-f]{12}$/);
  assert.equal(result.runners[0].status, 'UNKNOWN');
  assert.equal(result.runners[0].last_outcome, 'UNKNOWN');
});

test('AC-02 incomplete, non-synthetic, ambiguous or stale input fails closed', () => {
  const good = fixture();
  for (const input of [null, {}, {...good, kind: 'observed'},
    {...good, kind: 'cached'}, {...good, version: 2},
    {...good, extra: true}, {...good, heartbeat: null},
    {...good, heartbeat: {...good.heartbeat, runner_id: SECOND}},
    {...good, snapshot: {...good.snapshot, active: 999}},
    new Date(), Object.create({version: 1})]) {
    assert.deepEqual(observeSyntheticRunnerSource(input, BASE + 15), EMPTY);
  }
  for (const now of [null, -1, Number.NaN, BASE - 1]) {
    assert.deepEqual(observeSyntheticRunnerSource(good, now), EMPTY);
  }
  const accessor = {...good};
  Object.defineProperty(accessor, 'kind', {enumerable: true, get() {
    throw new Error('sensitive error');
  }});
  assert.deepEqual(observeSyntheticRunnerSource(accessor, BASE + 15), EMPTY);
});

test('AC-03 identifiers, session refs, secrets and PII never leave the source', () => {
  const good = fixture();
  const outcome = JSON.stringify(observeSyntheticRunnerSource(good, BASE + 15));
  for (const sensitive of [ID, SECRET, 'active_sessions', 'queued_orders', 'token']) {
    assert.ok(!outcome.includes(sensitive), sensitive);
  }
  const leaked = {...good, credentials: {token: SECRET}};
  assert.deepEqual(observeSyntheticRunnerSource(leaked, BASE + 15), EMPTY);
  const pii = {...good, heartbeat: {...good.heartbeat, email: 'person@example.com'}};
  assert.deepEqual(observeSyntheticRunnerSource(pii, BASE + 15), EMPTY);
});

test('AC-04 observer remains deterministic and performs no network, IO or commands', () => {
  const good = fixture();
  const before = JSON.stringify(good);
  assert.deepEqual(observeSyntheticRunnerSource(good, BASE + 15),
    observeSyntheticRunnerSource(good, BASE + 15));
  assert.equal(JSON.stringify(good), before);
  const source = readFileSync(new URL('../src/observer-synthetic-source.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:fs|net|http|https|child_process)['"]/);
  assert.doesNotMatch(source, /\b(?:fetch|listen|spawn|exec|writeFile|readFile|GITHUB_TOKEN)\s*\(/);
  assert.doesNotMatch(source, /\b(?:Date\.now|Math\.random)\s*\(/);
});
