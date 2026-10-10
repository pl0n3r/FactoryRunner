import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLocalObserverSnapshot } from '../src/local-observer-snapshot.ts';

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
  const stale = unknown({...input, freshness: 'STALE'});
  assert.equal(stale.capacity.available, null);
  assert.equal(stale.runners[0].reason, 'STALE');
  const offline = unknown({...input, runners: [{...input.runners[0], status: 'OFFLINE', reason: 'NO_CAPACITY'}]});
  assert.equal(offline.runners[0].status, 'OFFLINE');
  assert.equal(unknown({...input, observed_at: null}).freshness, 'UNKNOWN');
  assert.deepEqual(unknown({...input, runners: [{...input.runners[0], heartbeat_at: '2026-10-11T00:00:00Z'}]}), unknown(null));
  assert.deepEqual(unknown({...input, observed_at: '2026-02-30T00:00:00Z'}), unknown(null));
  assert.deepEqual(unknown({...input, freshness: 'NOT_A_REAL_STATE'}), unknown(null));
  // A global FRESH claim cannot turn a runner with no heartbeat into READY.
  const noHeartbeat = unknown({...input, runners: [{...input.runners[0], heartbeat_at: null}]});
  assert.equal(noHeartbeat.runners.length, 1);
  assert.equal(noHeartbeat.runners[0].status, 'UNKNOWN');
  assert.equal(noHeartbeat.runners[0].reason, 'UNKNOWN');
  assert.equal(noHeartbeat.runners[0].last_outcome, 'UNKNOWN');
  const validHeartbeat = unknown({...input, runners: [{...input.runners[0], heartbeat_at: '2026-10-10T11:59:59Z'}]});
  assert.equal(validHeartbeat.runners[0].status, 'READY');
  assert.equal(validHeartbeat.runners[0].heartbeat_at, '2026-10-10T11:59:59Z');
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
