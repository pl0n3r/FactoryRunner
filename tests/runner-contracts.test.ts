import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHeartbeatMatchesIdentity,
  availableCapacity,
  heartbeatHealth,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
} from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';

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

test('runner identity is location-agnostic, exact and capability-safe', () => {
  const hostinger = parseRunnerIdentity(identity());
  const mac = parseRunnerIdentity(identity({ location: 'macos-local' }));
  assert.deepEqual(hostinger.capabilities, ['git', 'openai-api']);
  assert.equal(mac.max_parallel, hostinger.max_parallel);
  assert.throws(() => parseRunnerIdentity(identity({ capabilities: [] })), /Capabilities inválidas/);
  assert.throws(() => parseRunnerIdentity(identity({ capabilities: ['git', 'git'] })), /duplicadas/);
  assert.throws(() => parseRunnerIdentity(identity({ runner_id: 'not-a-uuid' })), /runner_id inválido/);
  assert.throws(() => parseRunnerIdentity({ ...identity(), password: 'nope' }), /campos inválidos/);
});

test('runner heartbeat rejects inconsistent capacity, sessions and state', () => {
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ status: 'unknown' })), /Estado de heartbeat inválido/);
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ capacity: { max: 4, active: 5 } })), /capacity.active inválido/);
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ active_sessions: ['session_001', 'session_001'] })), /inconsistentes/);
  assert.throws(() => parseRunnerHeartbeat(heartbeat({ capacity: { max: 4, active: 0 }, active_sessions: ['session_001'] })), /inconsistentes/);
  assert.throws(
    () => parseRunnerHeartbeat(heartbeat({ active_sessions: ['gho_abcdefghijklmnopqrstuvwxyz123456'] })),
    /sensible/,
  );
});

test('heartbeat health is deterministic and fail-closed', () => {
  const parsed = parseRunnerHeartbeat(heartbeat());
  assert.equal(heartbeatHealth(parsed, 1050), 'healthy');
  assert.equal(heartbeatHealth(parsed, 1100), 'stale');
  assert.equal(heartbeatHealth(parsed, 1400), 'offline');
  assert.equal(heartbeatHealth(null, 1400), 'offline');
  assert.equal(heartbeatHealth(parsed, 900), 'offline');
  assert.equal(heartbeatHealth(parseRunnerHeartbeat(heartbeat({ status: 'offline' })), 1000), 'offline');
});

test('available capacity is bounded and only exposed for healthy non-draining runner', () => {
  const parsed = parseRunnerHeartbeat(heartbeat());
  assert.equal(availableCapacity(parsed, 1050), 3);
  assert.equal(availableCapacity(parsed, 1100), 0);
  assert.equal(availableCapacity(null, 1050), 0);
  assert.equal(availableCapacity(parseRunnerHeartbeat(heartbeat({ status: 'draining' })), 1050), 0);
  assert.equal(availableCapacity(parseRunnerHeartbeat(heartbeat({ capacity: { max: 4, active: 4 }, active_sessions: [] })), 1050), 0);
});

test('heartbeat identity binding rejects runner or max_parallel drift', () => {
  const parsedIdentity = parseRunnerIdentity(identity());
  const parsedHeartbeat = parseRunnerHeartbeat(heartbeat());
  assert.doesNotThrow(() => assertHeartbeatMatchesIdentity(parsedIdentity, parsedHeartbeat));
  assert.throws(
    () => assertHeartbeatMatchesIdentity(parsedIdentity, parseRunnerHeartbeat(heartbeat({ capacity: { max: 3, active: 1 } }))),
    /no coincide/,
  );
  assert.throws(
    () => assertHeartbeatMatchesIdentity(
      parsedIdentity,
      parseRunnerHeartbeat(heartbeat({ runner_id: '22222222-2222-7222-8222-222222222222' })),
    ),
    /otro runner/,
  );
});
