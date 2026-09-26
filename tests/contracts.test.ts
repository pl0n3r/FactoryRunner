import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEventTransition,
  assertHeartbeatMatchesIdentity,
  assertIdempotentOrder,
  availableCapacity,
  heartbeatHealth,
  orderFingerprint,
  parseExecutionEvent,
  parseExecutionOrder,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';

function identity(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git', 'openai-api'],
    max_parallel: 4,
    ...overrides,
  };
}

function heartbeat(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    sequence: 7,
    observed_at: 1000,
    status: 'ready',
    capacity: { max: 4, active: 1 },
    active_sessions: ['session_001'],
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'github:pl0n3r/FactoryRunner#2',
    runner_id: runnerId,
    capability: 'git',
    attempt: 1,
    issued_at: 1000,
    expires_at: 1300,
    instruction_ref: 'controlbot:work-items/runner-2/instruction',
    ...overrides,
  };
}

function event(state, sequence, overrides = {}) {
  return {
    version: 1,
    event_id: `33333333-3333-4333-8333-${String(sequence).padStart(12, '0')}`,
    order_id: orderId,
    runner_id: runnerId,
    sequence,
    state,
    occurred_at: 1000 + sequence,
    evidence: { code: 'ok', summary: 'evidencia saneada', ref: null },
    ...overrides,
  };
}

test('runner identity roundtrip is location-agnostic and rejects duplicates/extras', () => {
  const hostinger = parseRunnerIdentity(identity());
  const mac = parseRunnerIdentity(identity({ location: 'macos-local' }));
  assert.deepEqual(hostinger.capabilities, ['git', 'openai-api']);
  assert.equal(mac.max_parallel, hostinger.max_parallel);
  assert.throws(() => parseRunnerIdentity(identity({ capabilities: ['git', 'git'] })), /duplicadas/);
  assert.throws(() => parseRunnerIdentity({ ...identity(), password: 'nope' }), /campos inválidos/);
});

test('heartbeat health is deterministic and fail-closed', () => {
  const parsed = parseRunnerHeartbeat(heartbeat());
  assert.equal(heartbeatHealth(parsed, 1050), 'healthy');
  assert.equal(heartbeatHealth(parsed, 1100), 'stale');
  assert.equal(heartbeatHealth(parsed, 1400), 'offline');
  assert.equal(heartbeatHealth(null, 1400), 'offline');
  assert.equal(availableCapacity(parsed, 1050), 3);
  assert.equal(availableCapacity(parseRunnerHeartbeat(heartbeat({ status: 'draining' })), 1050), 0);
  assert.equal(heartbeatHealth(parsed, 900), 'offline');
  assert.deepEqual(parsed.active_sessions, ['session_001']);
  const parsedIdentity = parseRunnerIdentity(identity());
  assert.doesNotThrow(() => assertHeartbeatMatchesIdentity(parsedIdentity, parsed));
  assert.throws(
    () => assertHeartbeatMatchesIdentity(parsedIdentity, parseRunnerHeartbeat(heartbeat({ capacity: { max: 3, active: 1 } }))),
    /no coincide/,
  );
  assert.throws(
    () => assertHeartbeatMatchesIdentity(parsedIdentity, parseRunnerHeartbeat(heartbeat({ runner_id: '22222222-2222-7222-8222-222222222222' }))),
    /otro runner/,
  );
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ active_sessions: ['session_001', 'session_001'] })), /inconsistentes/);
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ capacity: { max: 4, active: 0 }, active_sessions: ['session_001'] })), /inconsistentes/);
});

test('execution order is closed, secret-free by shape, and idempotent', () => {
  const first = parseExecutionOrder(order());
  const same = parseExecutionOrder(order());
  assert.equal(orderFingerprint(first), orderFingerprint(same));
  assert.doesNotThrow(() => assertIdempotentOrder(first, same));
  const changed = parseExecutionOrder(order({ attempt: 2 }));
  assert.throws(() => assertIdempotentOrder(first, changed), /conflictivo/);
  assert.throws(() => parseExecutionOrder({ ...order(), token: 'secret' }), /campos inválidos/);
  assert.throws(() => parseExecutionOrder(order({ instruction_ref: 'https://example.com/prompt' })), /ControlBot/);
});

test('execution events enforce transitions and sanitize evidence', () => {
  const accepted = parseExecutionEvent(event('accepted', 1));
  const started = parseExecutionEvent(event('started', 2));
  const progress = parseExecutionEvent(event('progress', 3));
  const completed = parseExecutionEvent(event('completed', 4));
  assert.doesNotThrow(() => assertEventTransition(accepted, started));
  assert.doesNotThrow(() => assertEventTransition(started, progress));
  assert.doesNotThrow(() => assertEventTransition(progress, completed));
  assert.throws(() => assertEventTransition(completed, parseExecutionEvent(event('started', 5))), /Transición inválida/);
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, { evidence: { code: 'oops', summary: 'token=supersecret', ref: null } })),
    /sensible/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, { evidence: { code: 'ok', summary: 'ok', ref: 'https://evil.example/x' } })),
    /ref no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'ok', ref: 'https://github.com/pl0n3r/FactoryRunner/issues/2?token=private' },
    })),
    /ref no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'ok', ref: 'controlbot:private-token' },
    })),
    /ref no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'ok', ref: 'https://github.com/pl0n3r/%74oken/2' },
    })),
    /sensible/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'github_pat_abcdefghijklmnopqrstuvwxyz123456', ref: null },
    })),
    /sensible/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'ok', ref: 'https://user@github.com/pl0n3r/FactoryRunner' },
    })),
    /ref no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'ok', ref: 'https://github.com/pl0n3r/%2574oken/2' },
    })),
    /ref no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event('progress', 3, {
      evidence: { code: 'ok', summary: 'gho_abcdefghijklmnopqrstuvwxyz123456', ref: null },
    })),
    /sensible/,
  );
  assert.equal(parseRunnerIdentity(identity()).runner_id, runnerId);
});
