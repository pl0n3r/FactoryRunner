import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEventTransition,
  assertIdempotentOrder,
  assertInitialEventMatchesOrder,
  assertOrderExecutable,
  orderFingerprint,
  parseExecutionEvent,
  parseExecutionOrder,
  parseRunnerIdentity,
} from '../src/index.ts';
import { capability, slug } from '../src/validation.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

function identity(overrides = {}) {
  return parseRunnerIdentity({
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.1',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: ['git', 'openai-api'],
    max_parallel: 4,
    ...overrides,
  });
}

function order(overrides = {}) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:11',
    runner_id: runnerId,
    capability: 'git',
    attempt: 1,
    issued_at: 1_000,
    expires_at: 2_000,
    instruction_ref: 'controlbot:instruction:factoryrunner-11',
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    version: 1,
    event_id: '33333333-3333-7333-8333-333333333333',
    order_id: orderId,
    runner_id: runnerId,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1_010,
    evidence: {
      code: 'accepted',
      summary: 'Order accepted by runner',
      ref: 'controlbot:evidence:factoryrunner-11',
    },
    ...overrides,
  };
}

test('ExecutionOrder is exact, bounded and ControlBot-scoped', () => {
  const parsed = parseExecutionOrder(order());
  assert.equal(parsed.capability, 'git');
  assert.throws(() => parseExecutionOrder({ ...order(), extra: true }), /campos inválidos/);
  assert.throws(() => parseExecutionOrder(order({ order_id: 'bad' })), /order_id inválido/);
  assert.throws(() => parseExecutionOrder(order({ expires_at: 90_000 })), /TTL de orden excesivo/);
  assert.throws(() => parseExecutionOrder(order({ capability: 'Git' })), /capability inválido/);
  assert.throws(() => parseExecutionOrder(order({ instruction_ref: 'github:instruction:11' })), /ControlBot/);
  assert.throws(
    () => parseExecutionOrder(order({ instruction_ref: 'controlbot:token:supersecretvalue' })),
    /sensible/,
  );
});

test('capability grammar is bounded and distinct from slug', () => {
  for (const value of ['git', 'git.head', 'openai-api', 'browser.click_ref', 'browser.type_ref']) {
    assert.equal(capability(value, 'capability'), value);
  }

  for (const value of [
    'Git',
    'browser click_ref',
    'browser..click',
    'browser._ref',
    'browser.click_',
    '_browser',
    'browser/close',
    'a'.repeat(65),
  ]) {
    assert.throws(() => capability(value, 'capability'), /capability inválido/);
  }

  assert.equal(slug('git.head', 'slug'), 'git.head');
  assert.throws(() => slug('browser.click_ref', 'slug'), /slug inválido/);
  assert.equal(parseExecutionOrder(order({ capability: 'browser.click_ref' })).capability, 'browser.click_ref');
  assert.equal(parseExecutionOrder(order({ capability: 'browser.type_ref' })).capability, 'browser.type_ref');
});

test('order execution is bound to runner capability and time window', () => {
  const parsed = parseExecutionOrder(order());
  assert.doesNotThrow(() => assertOrderExecutable(parsed, identity(), 1_500));
  assert.throws(
    () => assertOrderExecutable(parsed, identity({ runner_id: '44444444-4444-7444-8444-444444444444' }), 1_500),
    /otro runner/,
  );
  assert.throws(
    () => assertOrderExecutable(parsed, identity({ capabilities: ['openai-api'] }), 1_500),
    /capability requerida/,
  );
  assert.throws(() => assertOrderExecutable(parsed, identity(), 999), /ventana ejecutable/);
  assert.throws(() => assertOrderExecutable(parsed, identity(), 2_000), /ventana ejecutable/);
});

test('order fingerprint is stable and order_id reuse is fail-closed', () => {
  const first = parseExecutionOrder(order());
  const same = parseExecutionOrder({ ...order() });
  const changed = parseExecutionOrder(order({ attempt: 2 }));
  assert.match(orderFingerprint(first), /^[0-9a-f]{64}$/);
  assert.equal(orderFingerprint(first), orderFingerprint(same));
  assert.doesNotThrow(() => assertIdempotentOrder(first, same));
  assert.throws(() => assertIdempotentOrder(first, changed), /Reuso conflictivo/);
});

test('ExecutionEvent validates state, sequence, evidence and safe refs', () => {
  const parsed = parseExecutionEvent(event());
  assert.equal(parsed.state, 'accepted');
  assert.throws(() => parseExecutionEvent(event({ state: 'unknown' })), /Estado de ejecución inválido/);
  assert.throws(() => parseExecutionEvent(event({ sequence: 0 })), /sequence inválido/);
  assert.throws(
    () => parseExecutionEvent(event({ evidence: { code: 'failed', summary: 'token=supersecretvalue', ref: null } })),
    /sensible/,
  );
  assert.doesNotThrow(() => parseExecutionEvent(event({
    evidence: { code: 'proof', summary: 'CI evidence', ref: 'https://github.com/pl0n3r/FactoryRunner/actions/runs/123' },
  })));
  assert.throws(
    () => parseExecutionEvent(event({
      evidence: { code: 'proof', summary: 'CI evidence', ref: 'https://github.com/pl0n3r/FactoryRunner/../private' },
    })),
    /no permitido/,
  );
  assert.throws(
    () => parseExecutionEvent(event({
      evidence: { code: 'proof', summary: 'CI evidence', ref: 'https://github.com/pl0n3r/FactoryRunner?foo=bar' },
    })),
    /no permitido/,
  );
});

test('initial event and transitions remain bound and deterministic', () => {
  const parsedOrder = parseExecutionOrder(order());
  const accepted = parseExecutionEvent(event());
  assert.doesNotThrow(() => assertInitialEventMatchesOrder(parsedOrder, accepted));
  assert.throws(
    () => assertInitialEventMatchesOrder(parsedOrder, parseExecutionEvent(event({ state: 'started' }))),
    /Primer evento inválido/,
  );
  assert.throws(
    () => assertInitialEventMatchesOrder(parsedOrder, parseExecutionEvent(event({ occurred_at: 2_000 }))),
    /ventana de la orden/,
  );

  const started = parseExecutionEvent(event({
    event_id: '44444444-4444-7444-8444-444444444444',
    sequence: 2,
    state: 'started',
    occurred_at: 1_020,
  }));
  const completed = parseExecutionEvent(event({
    event_id: '55555555-5555-7555-8555-555555555555',
    sequence: 3,
    state: 'completed',
    occurred_at: 1_030,
  }));
  assert.doesNotThrow(() => assertEventTransition(accepted, started));
  assert.doesNotThrow(() => assertEventTransition(started, completed));
  assert.throws(() => assertEventTransition(completed, parseExecutionEvent(event({
    event_id: '66666666-6666-7666-8666-666666666666',
    sequence: 4,
    state: 'progress',
    occurred_at: 1_040,
  }))), /Transición inválida/);
  assert.throws(() => assertEventTransition(started, parseExecutionEvent(event({
    event_id: '77777777-7777-7777-8777-777777777777',
    sequence: 4,
    state: 'progress',
    occurred_at: 1_025,
  }))), /Secuencia de eventos inválida/);
});
