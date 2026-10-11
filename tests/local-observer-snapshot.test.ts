import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLocalObserverSnapshot } from '../src/local-observer-snapshot.ts';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

function fixture() {
  return {version: 1, provenance: 'observed', freshness: 'FRESH', observed_at: '2026-10-10T12:00:00Z',
    capacity: {total: 3, available: 1}, queue: {pending: 2, blocked: 1},
    runners: [{id: 'runner-001', status: 'READY', reason: 'NONE', heartbeat_at: '2026-10-10T11:59:00Z', last_outcome: 'SUCCESS'}]};
}
function unknown(value: unknown) { return projectLocalObserverSnapshot(value); }

test('canonical safe fields are projected without aliases, extensions or mutation', () => {
  const input = fixture();
  const serialized = JSON.stringify(input);
  const result = unknown(input);
  assert.equal(JSON.stringify(input), serialized);
  assert.notEqual(result, input);
  assert.notEqual(result.capacity, input.capacity);
  assert.notEqual(result.runners[0], input.runners[0]);
  assert.deepEqual(result, input);
  assert.deepEqual(Object.keys(result).sort(), ['version','provenance','freshness','observed_at','capacity','queue','runners'].sort());
  assert.deepEqual(Object.keys(result.runners[0]).sort(), ['id','status','reason','heartbeat_at','last_outcome'].sort());
  for (const variant of [
    {...input, extra: 'unexpected'}, {...input, capacity: {...input.capacity, extra: 4}},
    {...input, queue: {...input.queue, unknown: 1}},
    {...input, runners: [{...input.runners[0], unexpected: 1}]},
    {...input, runners: [input.runners[0], {...input.runners[0]}]},
    {...input, capacity: {total: 1, available: 2}},
    {...input, capacity: {total: Number.POSITIVE_INFINITY, available: 1}},
    {...input, queue: {pending: -1, blocked: 2}},
    {...input, runners: Array(41).fill(input.runners[0])},
    {...input, runners: [{...input.runners[0], id: 'user@example.com'}]},
    {...input, runners: [{...input.runners[0], id: 'runner-1', status: 'GREEN'}]},
    {...input, runners: [{...input.runners[0], reason: 'arbitrary error'}]},
  ]) {
    assert.deepEqual(unknown(variant), unknown(null));
  }
});

test('stale cached synthetic and unordered times fail closed without live readiness', () => {
  const input = fixture();
  const cached = unknown({...input, provenance: 'cached', freshness: 'FRESH'});
  assert.equal(cached.freshness, 'STALE');
  assert.equal(cached.capacity.available, null);
  assert.equal(cached.runners[0].status, 'UNKNOWN');
  assert.equal(cached.runners[0].reason, 'STALE');
  const synthetic = unknown({...input, provenance: 'synthetic', freshness: 'FRESH'});
  assert.equal(synthetic.provenance, 'synthetic');
  assert.equal(synthetic.freshness, 'UNKNOWN');
  assert.equal(synthetic.observed_at, null);
  assert.equal(synthetic.runners[0].status, 'UNKNOWN');
  const syntheticStale = unknown({...input, provenance: 'synthetic', freshness: 'STALE'});
  assert.equal(syntheticStale.provenance, 'synthetic');
  assert.equal(syntheticStale.freshness, 'UNKNOWN');
  assert.equal(syntheticStale.capacity.available, null);
  assert.equal(syntheticStale.runners[0].status, 'UNKNOWN');
  assert.equal(syntheticStale.runners[0].reason, 'UNKNOWN');
  assert.equal(syntheticStale.runners[0].last_outcome, 'UNKNOWN');
  const stale = unknown({...input, freshness: 'STALE'});
  assert.equal(stale.capacity.available, null);
  assert.equal(stale.runners[0].reason, 'STALE');
  const offline = unknown({...input, capacity: {total: 3, available: 0},
    runners: [{...input.runners[0], status: 'OFFLINE', reason: 'NO_CAPACITY'}]});
  assert.equal(offline.runners[0].status, 'OFFLINE');
  assert.equal(unknown({...input, observed_at: null}).freshness, 'UNKNOWN');
  assert.deepEqual(unknown({...input, runners: [{...input.runners[0], heartbeat_at: '2026-10-11T00:00:00Z'}]}), unknown(null));
  assert.deepEqual(unknown({...input, observed_at: '2026-02-30T00:00:00Z'}), unknown(null));
  assert.deepEqual(unknown({...input, freshness: 'NOT_A_REAL_STATE'}), unknown(null));
  // A global FRESH claim cannot turn a runner with no heartbeat into READY.
  const noHeartbeat = unknown({...input, capacity: {total: 3, available: 0}, runners: [{...input.runners[0], heartbeat_at: null}]});
  assert.equal(noHeartbeat.runners.length, 1);
  assert.equal(noHeartbeat.runners[0].status, 'UNKNOWN');
  assert.equal(noHeartbeat.runners[0].reason, 'UNKNOWN');
  assert.equal(noHeartbeat.runners[0].last_outcome, 'UNKNOWN');
  assert.equal(noHeartbeat.capacity.available, null, 'unverified READY cannot leave positive availability');
  const validHeartbeat = unknown({...input, runners: [{...input.runners[0], heartbeat_at: '2026-10-10T11:59:59Z'}]});
  assert.equal(validHeartbeat.runners[0].status, 'READY');
  assert.equal(validHeartbeat.runners[0].heartbeat_at, '2026-10-10T11:59:59Z');
  assert.equal(validHeartbeat.capacity.available, 1, 'fresh READY preserves independently reported capacity');
  // A READY runner with a blocking or unknown reason is never actionable.
  for (const reason of ['HUMAN_GATE', 'CLAIMS', 'NO_CAPACITY', 'DEPENDENCY', 'STALE', 'UNKNOWN'] as const) {
    const contradictory = unknown({...input, capacity: {total: 3, available: 0}, runners: [{...input.runners[0], reason}]});
    assert.equal(contradictory.runners.length, 1);
    assert.equal(contradictory.runners[0].status, 'UNKNOWN');
    assert.equal(contradictory.runners[0].reason, reason);
    assert.equal(contradictory.runners[0].last_outcome, 'UNKNOWN');
    assert.equal(contradictory.capacity.available, null);
  }
  const noBlocker = unknown({...input, runners: [{...input.runners[0], reason: 'NONE', heartbeat_at: '2026-10-10T11:59:59Z'}]});
  assert.equal(noBlocker.runners[0].status, 'READY');
  assert.equal(noBlocker.runners[0].reason, 'NONE');
  // Match runner.ts heartbeatHealth's 90-second boundary.
  const atLimit = unknown({...input, runners: [{...input.runners[0], heartbeat_at: '2026-10-10T11:58:30Z'}]});
  assert.equal(atLimit.runners[0].status, 'READY');
  assert.equal(atLimit.capacity.available, 1);
  const tooOld = unknown({...input, capacity: {total: 3, available: 0}, runners: [{...input.runners[0], heartbeat_at: '2026-10-10T11:58:29Z'}]});
  assert.equal(tooOld.runners[0].status, 'UNKNOWN');
  assert.equal(tooOld.runners[0].reason, 'STALE');
  assert.equal(tooOld.runners[0].last_outcome, 'UNKNOWN');
  assert.equal(tooOld.capacity.available, null);
  const ancient = unknown({...input, capacity: {total: 3, available: 0}, runners: [{...input.runners[0], heartbeat_at: '2020-01-01T00:00:00Z'}]});
  assert.equal(ancient.runners[0].status, 'UNKNOWN');
  assert.equal(ancient.runners[0].reason, 'STALE');
  // Original blocking reason still wins over an old heartbeat.
  const blockedOld = unknown({...input, capacity: {total: 3, available: 0}, runners: [{...input.runners[0], reason: 'HUMAN_GATE',
    heartbeat_at: '2020-01-01T00:00:00Z'}]});
  assert.equal(blockedOld.runners[0].status, 'UNKNOWN');
  assert.equal(blockedOld.runners[0].reason, 'HUMAN_GATE');
  assert.equal(blockedOld.capacity.available, null);
  // Mixed signals cannot claim trusted aggregate spare capacity either.
  const mixed = unknown({...input, runners: [
    input.runners[0], {...input.runners[0], id: 'runner-002', heartbeat_at: null},
  ]});
  assert.equal(mixed.runners[0].status, 'READY');
  assert.equal(mixed.runners[1].status, 'UNKNOWN');
  assert.equal(mixed.capacity.available, null);
  // An unverified non-READY roster must not certify spare capacity.
  const waiting = unknown({...input, runners: [{...input.runners[0], status: 'WAITING'}]});
  assert.deepEqual(waiting, unknown(null));
  const waitingZero = unknown({...input, capacity: {total: 3, available: 0},
    runners: [{...input.runners[0], status: 'WAITING'}]});
  assert.equal(waitingZero.capacity.available, 0);
  assert.equal(waitingZero.runners[0].status, 'WAITING');
  // Case variants of the same hexadecimal alias must not represent two runners.
  assert.deepEqual(unknown({...input, runners: [{...input.runners[0], id: 'runner-ABC'}]}), unknown(null));
  assert.deepEqual(unknown({...input, runners: [
    {...input.runners[0], id: 'runner-abc'},
    {...input.runners[0], id: 'runner-ABC'},
  ]}), unknown(null));
});

test('secrets PII HTML and hostile accessors never leak into projection or errors', () => {
  const input = fixture();
  const original = JSON.stringify(input);
  const invalids = [
    {...input, secret: 'TOP_SECRET_SENTINEL'},
    {...input, runners: [{...input.runners[0], id: 'runner-ghp_THIS_IS_A_TOKEN'}]},
    {...input, runners: [{...input.runners[0], id: '<img src=x onerror=alert(1)>'}]},
    {...input, runners: [{...input.runners[0], id: 'PRIVATE-email@example.com'}]},
    {...input, runners: [{...input.runners[0], id: 'runner-token-test'}]},
    {...input, runners: [{...input.runners[0], id: 'runner-a'.repeat(1000)}]},
  ];
  for (const candidate of invalids) {
    const text = JSON.stringify(unknown(candidate));
    assert.doesNotMatch(text, /TOP_SECRET_SENTINEL|ghp_|<img|PRIVATE-email|runner-token-test/);
    assert.deepEqual(unknown(candidate), unknown(null));
  }
  assert.equal(JSON.stringify(input), original);
  let reads = 0;
  const accessor = fixture();
  Object.defineProperty(accessor.runners[0], 'reason', {enumerable: true, get() { reads++; return '<svg onload=alert(1)>'; }});
  assert.deepEqual(unknown(accessor), unknown(null));
  assert.equal(reads, 0);
  const rootAccessor = fixture();
  Object.defineProperty(rootAccessor, 'observed_at', {enumerable: true, get() { reads++; throw new Error('PRIVATE'); }});
  assert.deepEqual(unknown(rootAccessor), unknown(null));
  assert.equal(reads, 0);
  assert.deepEqual(unknown(new Proxy({}, {ownKeys() { throw new Error('PRIVATE'); }})), unknown(null));
  const massive = {...input, runners: Array(100000).fill(input.runners[0])};
  assert.deepEqual(unknown(massive), unknown(null));
  assert.equal(unknown(massive).runners.length, 0);
});

test('AC01 observed FRESH empty roster cannot carry positive availability', () => {
  const baseline = fixture();
  for (const count of [1, 2, 3]) {
    const contradicted = {...baseline, capacity: {total: 3, available: count}, runners: []};
    const before = JSON.stringify(contradicted);
    const view = unknown(contradicted);
    assert.deepEqual(view, unknown(null));
    assert.equal(view.provenance, 'synthetic');
    assert.equal(view.freshness, 'UNKNOWN');
    assert.equal(view.capacity.available, null);
    assert.deepEqual(view.runners, []);
    assert.equal(JSON.stringify(contradicted), before);
  }
});

test('AC02 empty nonpositive roster and supported READY semantics remain compatible', () => {
  const baseline = fixture();
  const observedZero = unknown({...baseline, capacity: {total: 3, available: 0}, runners: []});
  assert.equal(observedZero.provenance, 'observed');
  assert.equal(observedZero.freshness, 'FRESH');
  assert.equal(observedZero.capacity.available, 0);
  assert.deepEqual(observedZero.runners, []);
  const observedNull = unknown({...baseline, capacity: {total: 3, available: null}, runners: []});
  assert.equal(observedNull.capacity.available, null);
  const positiveWithRunner = unknown(baseline);
  assert.equal(positiveWithRunner.provenance, 'observed');
  assert.equal(positiveWithRunner.capacity.available, 1);
  assert.equal(positiveWithRunner.runners[0].status, 'READY');
  for (const provenance of ['cached', 'synthetic'] as const) {
    const view = unknown({...baseline, provenance, runners: []});
    assert.equal(view.capacity.available, null);
    assert.notEqual(view.freshness, 'FRESH');
  }
});

test('AC03 denial is bounded privacy-preserving and grants no new authority', () => {
  const baseline = fixture();
  const userSupplied = {...baseline, capacity: {total: 3, available: 1}, runners: [],
    queue: {pending: 2, blocked: 1}};
  const view = unknown(userSupplied);
  assert.deepEqual(Object.keys(view).sort(),
    ['version','provenance','freshness','observed_at','capacity','queue','runners'].sort());
  assert.deepEqual(view, unknown(null));
  const serialized = JSON.stringify(view);
  for (const forbidden of ['runner-001', 'PRIVATE_EVIDENCE_SENTINEL',
    'private-session-sentinel', 'token=', 'READY', 'FRESH']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.equal(view.capacity.total, null);
  assert.equal(view.capacity.available, null);
  assert.deepEqual(view.queue, {pending: null, blocked: null});
  const html = renderLocalObserverHtml(view);
  assert.match(html, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.match(html, /Capacidad disponible<span class="value">UNKNOWN/);
  assert.doesNotMatch(html, /Capacidad disponible<span class="value">[1-9]/);
  assert.doesNotMatch(html, /<\s*(?:script|form|button|iframe|a)\b/i);
  for (const forbidden of ['runner-001', 'PRIVATE_EVIDENCE_SENTINEL',
    'private-session-sentinel', 'token=', 'READY (reportado)']) {
    assert.ok(!html.includes(forbidden), forbidden);
  }
});

test('AC01 nonready roster positive capacity fails closed', () => {
  const base = fixture();
  for (const [status, reason] of [
    ['OFFLINE', 'STALE'], ['WAITING', 'NO_CAPACITY'], ['BLOCKED', 'HUMAN_GATE'],
  ] as const) {
    for (const available of [1, 2, 3]) {
      const input = {...base, capacity: {total: 3, available},
        runners: [{...base.runners[0], status, reason}]};
      const serialized = JSON.stringify(input);
      const view = unknown(input);
      assert.deepEqual(view, unknown(null), status + '/' + available);
      assert.equal(view.capacity.available, null);
      assert.equal(view.freshness, 'UNKNOWN');
      assert.equal(JSON.stringify(input), serialized);
    }
  }
  const mixedNonready = unknown({...base, runners: [
    {...base.runners[0], status: 'OFFLINE', reason: 'STALE'},
    {...base.runners[0], id: 'runner-002', status: 'WAITING', reason: 'NO_CAPACITY'},
  ]});
  assert.deepEqual(mixedNonready, unknown(null));
});

test('AC02 READY heartbeat and nonpositive capacity stay compatible', () => {
  const base = fixture();
  const ready = unknown(base);
  assert.equal(ready.capacity.available, 1);
  assert.equal(ready.runners[0].status, 'READY');
  for (const available of [0, null]) {
    for (const status of ['OFFLINE', 'WAITING', 'BLOCKED'] as const) {
      const v = unknown({...base, capacity: {total: 3, available},
        runners: [{...base.runners[0], status, reason: 'NO_CAPACITY'}]});
      assert.equal(v.provenance, 'observed');
      assert.equal(v.capacity.available, available);
      assert.equal(v.runners[0].status, status);
    }
  }
  for (const provenance of ['synthetic', 'cached'] as const) {
    const v = unknown({...base, provenance});
    assert.equal(v.capacity.available, null);
    assert.notEqual(v.freshness, 'FRESH');
  }
  const stale = unknown({...base, freshness: 'STALE'});
  assert.equal(stale.capacity.available, null);
  const atLimit = unknown({...base, runners: [{...base.runners[0],
    heartbeat_at: '2026-10-10T11:58:30Z'}]});
  assert.equal(atLimit.capacity.available, 1);
  const pastLimit = unknown({...base, runners: [{...base.runners[0],
    heartbeat_at: '2026-10-10T11:58:29Z'}]});
  assert.equal(pastLimit.capacity.available, null);
});

test('AC03 nonready denial remains private and does not grant authority', () => {
  const base = fixture();
  const input = {...base, capacity: {total: 3, available: 2},
    queue: {pending: 987654, blocked: 4321},
    runners: [{...base.runners[0], status: 'BLOCKED', reason: 'HUMAN_GATE'}]};
  const view = unknown(input);
  assert.deepEqual(view, unknown(null));
  assert.deepEqual(view.queue, {pending: null, blocked: null});
  assert.deepEqual(view.capacity, {total: null, available: null});
  const json = JSON.stringify(view);
  for (const sentinel of ['987654', '4321', 'runner-001', 'READY', 'FRESH']) {
    assert.ok(!json.includes(sentinel), sentinel);
  }
  const html = renderLocalObserverHtml(view);
  assert.match(html, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.match(html, /Capacidad disponible<span class="value">UNKNOWN/);
  assert.doesNotMatch(html, /987654|4321|runner-001|READY \(reportado\)/);
  assert.doesNotMatch(html, /<\s*(?:script|form|button|iframe|a)\b/i);
});
