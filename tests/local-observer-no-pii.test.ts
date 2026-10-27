import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { capacitySnapshot } from '../src/result.ts';
import { projectSyntheticObserverFromExports } from '../src/local-observer-source-adapter.ts';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

// Deliberately fictitious identifiers. Nothing here is a real person or account.
const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const BASE = 1_700_000_100;
const PERSON = {
  name: 'persona-ficticia-local-0007',
  email: 'persona-ficticia@example.invalid',
  telephone: 'telefono-ficticio-0007',
  address: 'domicilio-ficticio-solo-prueba',
} as const;
const PRIVATE_VALUES = [RUNNER_ID, ...Object.values(PERSON)];

function fixture() {
  const identity = {
    version: 1, runner_id: RUNNER_ID, protocol_version: 1,
    runtime: 'node', runtime_version: '0.1.5', platform: 'macos-arm64',
    location: 'local', capabilities: ['git'], max_parallel: 4,
  };
  const heartbeat = {
    version: 1, runner_id: RUNNER_ID, sequence: 7, observed_at: BASE,
    status: 'ready', capacity: {max: 4, active: 1},
    active_sessions: [PERSON.name],
  };
  const queue = {version: 1, runner_id: RUNNER_ID,
    observed_at: BASE, queued_orders: 9};
  return {
    snapshot: capacitySnapshot(identity, heartbeat, queue, BASE + 15),
    heartbeat,
  };
}

function assertNoPrivateOutput(output: unknown) {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  for (const value of PRIVATE_VALUES) {
    assert.equal(serialized.includes(value), false, 'private fixture escaped observer boundary');
  }
}

test('AC-01: personal fixture data never escapes the local observer UI/DTO boundary', (t) => {
  const messages: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { messages.push(args); });
  }
  const {snapshot, heartbeat} = fixture();
  const dto = projectSyntheticObserverFromExports(snapshot, heartbeat, BASE + 15);
  const html = renderLocalObserverHtml(dto);
  const publicPacket = JSON.stringify({observer: dto, rendered_html: html});

  assert.equal(dto.provenance, 'synthetic');
  assert.equal(dto.freshness, 'UNKNOWN');
  assert.equal(dto.observed_at, null);
  assert.deepEqual(dto.capacity, {total: 4, available: null});
  assert.deepEqual(dto.queue, {pending: null, blocked: null});
  assert.equal(dto.runners.length, 1);
  assert.match(dto.runners[0].id, /^runner-[0-9a-f]{12}$/);
  assert.equal(dto.runners[0].status, 'UNKNOWN');
  assert.equal(dto.runners[0].reason, 'UNKNOWN');
  assert.equal(dto.runners[0].last_outcome, 'UNKNOWN');
  assert.match(html, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assertNoPrivateOutput(dto);
  assertNoPrivateOutput(html);
  assertNoPrivateOutput(publicPacket);
  assert.deepEqual(messages, [], 'observer emitted log messages');
});

test('AC-02: missing, ambiguous and poisoned personal data always fail closed', () => {
  const {snapshot, heartbeat} = fixture();
  const poisoned = {...heartbeat};
  Object.defineProperty(poisoned, 'status', {
    enumerable: true,
    get() { throw new Error(PERSON.email); },
  });
  const cases: ReadonlyArray<readonly [unknown, unknown, unknown]> = [
    [null, heartbeat, BASE + 15],
    [snapshot, null, BASE + 15],
    [snapshot, heartbeat, Number.NaN],
    [{...snapshot, email: PERSON.email}, heartbeat, BASE + 15],
    [snapshot, {...heartbeat, person: PERSON.address}, BASE + 15],
    [snapshot, {...heartbeat, active_sessions: [{name: PERSON.name}]}, BASE + 15],
    [snapshot, {...heartbeat, runner_id: PERSON.telephone}, BASE + 15],
    [snapshot, poisoned, BASE + 15],
  ];
  const expected = {
    version: 1, provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
    capacity: {total: null, available: null},
    queue: {pending: null, blocked: null}, runners: [],
  };
  for (const [capacity, source, now] of cases) {
    const dto = projectSyntheticObserverFromExports(capacity, source, now);
    const html = renderLocalObserverHtml(dto);
    assert.deepEqual(dto, expected);
    assert.match(html, /UNKNOWN/);
    assertNoPrivateOutput(dto);
    assertNoPrivateOutput(html);
  }
});

test('AC-03: neither logs nor published package entrypoints expose private observer source', () => {
  const source = readFileSync(
    new URL('../src/local-observer-source-adapter.ts', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {files: string[]; exports: Record<string, string>};
  assert.doesNotMatch(source, /\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/);
  assert.doesNotMatch(source, /\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(/);
  assert.doesNotMatch(source, /\b(?:fetch|sendBeacon|writeFile|appendFile|spawn|exec)\s*\(/);
  assert.equal(
    Object.values(manifest.exports).some((entry) =>
      entry.includes('local-observer-source-adapter')), false,
  );
  assert.equal(
    manifest.files.some((entry) =>
      entry.includes('local-observer-source-adapter')
      || entry === 'src' || entry === 'src/'), false,
  );
  assertNoPrivateOutput(source);
  assertNoPrivateOutput(manifest);
});

test('AC-04: offline observer projection is deterministic and grants no authority', () => {
  const {snapshot, heartbeat} = fixture();
  const before = JSON.stringify({snapshot, heartbeat});
  const first = projectSyntheticObserverFromExports(snapshot, heartbeat, BASE + 15);
  const second = projectSyntheticObserverFromExports(snapshot, heartbeat, BASE + 15);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify({snapshot, heartbeat}), before);
  assert.deepEqual(Object.keys(first).sort(), [
    'version', 'provenance', 'freshness', 'observed_at', 'capacity', 'queue', 'runners',
  ].sort());
  assert.equal(first.capacity.available, null);
  assert.equal(first.queue.pending, null);
  assert.equal(first.runners[0].last_outcome, 'UNKNOWN');
  assert.doesNotMatch(renderLocalObserverHtml(first), /<\s*(?:script|iframe|form|button)\b/i);
  assertNoPrivateOutput(first);
});
