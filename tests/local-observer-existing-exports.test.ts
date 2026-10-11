import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { capacitySnapshot, type CapacitySnapshot } from '../src/result.ts';
import {
  heartbeatHealth, parseRunnerHeartbeat, type RunnerHeartbeat,
} from '../src/runner.ts';
import { projectLocalObserverSnapshot } from '../src/local-observer-snapshot.ts';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

// #476 verifies the *existing exports* against the observer v1 DTO. No collector,
// read of live files, network request, browser access, or execution authority.
const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_ID = '22222222-2222-7222-8222-222222222222';
const OBSERVED = 1_700_000_100;
const PRIVATE_SESSION = 'private-session-sentinel-123';

function identity(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, runner_id: RUNNER_ID, protocol_version: 1, runtime: 'node',
    runtime_version: '0.1.5', platform: 'macos-arm64', location: 'local',
    capabilities: ['git'], max_parallel: 4, ...overrides,
  };
}
function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, runner_id: RUNNER_ID, sequence: 7, observed_at: OBSERVED,
    status: 'ready', capacity: { max: 4, active: 1 },
    active_sessions: [PRIVATE_SESSION], ...overrides,
  };
}
function queue(overrides: Record<string, unknown> = {}) {
  return { version: 1, runner_id: RUNNER_ID, observed_at: OBSERVED,
    queued_orders: 17, ...overrides };
}

/** Test-only allowlisted fixture bridge, NOT an adapter or observed-data source. */
function syntheticView(snapshot: CapacitySnapshot, source: RunnerHeartbeat) {
  const alias = 'runner-' + createHash('sha256').update(snapshot.runner_id).digest('hex').slice(0, 12);
  const dto = {
    version: 1,
    provenance: 'synthetic',
    freshness: 'UNKNOWN',
    observed_at: null,
    capacity: { total: snapshot.max_parallel, available: null },
    // queued_orders is a runner-local queue, NOT the global Factory queue.
    queue: { pending: null, blocked: null },
    runners: [{
      id: alias, status: 'UNKNOWN', reason: 'UNKNOWN',
      heartbeat_at: new Date(source.observed_at * 1000).toISOString().replace('.000Z', 'Z'),
      last_outcome: 'UNKNOWN',
    }],
  };
  return projectLocalObserverSnapshot(dto);
}

test('AC01 existing capacity export passes only as synthetic DTO and read-only HTML', () => {
  const hb = heartbeat();
  const capacity = capacitySnapshot(identity(), hb, queue(), OBSERVED + 30);
  assert.equal(capacity.runner_status, 'ready');
  assert.equal(capacity.queued_orders, 17);
  assert.equal(capacity.available, 3);
  const dto = syntheticView(capacity, parseRunnerHeartbeat(hb));
  const html = renderLocalObserverHtml(dto);
  assert.equal(dto.version, 1);
  assert.equal(dto.provenance, 'synthetic');
  assert.equal(dto.freshness, 'UNKNOWN');
  assert.equal(dto.observed_at, null);
  assert.equal(dto.capacity.total, 4);
  assert.equal(dto.capacity.available, null);
  assert.deepEqual(dto.queue, {pending: null, blocked: null});
  assert.equal(dto.runners[0].status, 'UNKNOWN');
  assert.equal(dto.runners[0].reason, 'UNKNOWN');
  assert.equal(dto.runners[0].last_outcome, 'UNKNOWN');
  assert.match(dto.runners[0].id, /^runner-[0-9a-f]{12}$/);
  assert.match(html, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.match(html, /Capacidad disponible<span class="value">UNKNOWN/);
  assert.match(html, /En espera \/ bloqueados<span class="value">UNKNOWN \/ UNKNOWN/);
  assert.ok(!html.includes('READY (reportado)'));
  assert.ok(!html.includes(RUNNER_ID));
});

test('AC02 stale offline future timestamps and cross-runner drift fail closed', () => {
  const hb = heartbeat();
  const parsed = parseRunnerHeartbeat(hb);
  assert.equal(heartbeatHealth(parsed, OBSERVED + 90), 'healthy');
  assert.equal(heartbeatHealth(parsed, OBSERVED + 91), 'stale');
  assert.equal(heartbeatHealth(parsed, OBSERVED + 301), 'offline');
  assert.equal(heartbeatHealth(null, OBSERVED), 'offline');

  const healthy = capacitySnapshot(identity(), hb, queue(), OBSERVED + 90);
  assert.equal(healthy.available, 3);
  for (const [age, expected] of [[91, 'stale'], [301, 'offline']] as const) {
    const now = OBSERVED + age;
    const stale = capacitySnapshot(identity(), hb, queue(), now);
    assert.equal(heartbeatHealth(parsed, now), expected);
    assert.equal(stale.runner_status, 'ready', 'raw ready is historical, not freshness');
    assert.equal(stale.available, 0);
    assert.equal(stale.dispatchable_orders, 0);
    const dto = syntheticView(stale, parsed);
    assert.equal(dto.capacity.available, null);
    assert.equal(dto.runners[0].status, 'UNKNOWN');
    assert.doesNotMatch(renderLocalObserverHtml(dto), /READY \(reportado\)/);
  }
  assert.throws(() => capacitySnapshot(identity(), hb, queue(), OBSERVED - 1), /futuro/);
  assert.equal(heartbeatHealth(parsed, OBSERVED - 1), 'offline');
  assert.throws(() => capacitySnapshot(identity({runner_id: OTHER_ID}), hb, queue(), OBSERVED + 30), /otro runner/);
  assert.throws(() => capacitySnapshot(identity(), heartbeat({runner_id: OTHER_ID}),
    queue(), OBSERVED + 30), /otro runner/);
  assert.throws(() => capacitySnapshot(identity(), hb, queue({runner_id: OTHER_ID}),
    OBSERVED + 30), /otro runner/);
  assert.throws(() => capacitySnapshot(identity(), hb, queue({observed_at: OBSERVED - 1}),
    OBSERVED + 30), /mismo snapshot/);
  assert.throws(() => capacitySnapshot(identity({max_parallel: 2}), hb, queue(),
    OBSERVED + 30), /no coincide/);
  assert.throws(() => capacitySnapshot(identity(), null, queue(), OBSERVED + 30), /RunnerHeartbeat/);
});

test('AC03 session UUID and evidence sentinels never reach DTO or HTML', () => {
  const hb = heartbeat();
  const cap = capacitySnapshot(identity(), hb, queue(), OBSERVED + 30);
  const dto = syntheticView(cap, parseRunnerHeartbeat(hb));
  const html = renderLocalObserverHtml(dto);
  for (const forbidden of [PRIVATE_SESSION, RUNNER_ID, 'token=private-sentinel',
    'PRIVATE_EVIDENCE_SENTINEL', 'active_sessions', 'ExecutionEvidence']) {
    assert.ok(!JSON.stringify(dto).includes(forbidden), forbidden);
    assert.ok(!html.includes(forbidden), forbidden);
  }
  // A caller must not accidentally pass extra fields from raw runtime objects.
  const polluted = {...dto, evidence: {summary: 'PRIVATE_EVIDENCE_SENTINEL'}};
  const denied = projectLocalObserverSnapshot(polluted);
  assert.equal(denied.freshness, 'UNKNOWN');
  assert.deepEqual(denied.runners, []);
  assert.ok(!renderLocalObserverHtml(denied).includes('PRIVATE_EVIDENCE_SENTINEL'));
  assert.doesNotMatch(html, /<\s*(?:script|form|button|iframe|a)\b/i);
  assert.match(html, /SIN VALIDACIÓN EN PRODUCCIÓN|NO LIVE/);
});

test('AC04 synthetic export fixture bridge remains offline and authority-neutral', () => {
  const hb = heartbeat();
  const original = JSON.stringify(hb);
  const cap = capacitySnapshot(identity(), hb, queue(), OBSERVED + 30);
  const dto = syntheticView(cap, parseRunnerHeartbeat(hb));
  assert.equal(JSON.stringify(hb), original, 'no mutation of runtime input');
  assert.deepEqual(Object.keys(dto).sort(),
    ['version', 'provenance', 'freshness', 'observed_at', 'capacity', 'queue', 'runners'].sort());
  assert.deepEqual(Object.keys(dto.runners[0]).sort(),
    ['id', 'status', 'reason', 'heartbeat_at', 'last_outcome'].sort());
  assert.deepEqual(Object.keys(cap).sort(), [
    'version', 'runner_id', 'observed_at', 'heartbeat_sequence', 'runner_status',
    'max_parallel', 'active', 'available', 'queued_orders', 'dispatchable_orders',
  ].sort());
  assert.equal(dto.capacity.available, null);
  assert.equal(dto.queue.pending, null);
  assert.equal(dto.runners[0].last_outcome, 'UNKNOWN');
});
