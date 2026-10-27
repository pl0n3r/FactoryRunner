import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessControlBotHealth,
  createControlBotHealthSimulator,
  newHealthChallenge,
} from '../src/controlbot-health-contract.ts';
import type {
  ControlBotHealthTrust,
  SignedControlBotHealth,
} from '../src/controlbot-health-contract.ts';

const INSTANCE = '11111111-1111-7111-8111-111111111111';
const NONCE = '22222222-2222-7222-8222-222222222222';
const RELEASE_SHA = 'a'.repeat(40);
const OBSERVED_AT = 1_800_000_000;

function fixture() {
  const simulator = createControlBotHealthSimulator({
    instance_id: INSTANCE,
    release_version: '0.1.0',
    release_sha: RELEASE_SHA,
  });
  const trust: ControlBotHealthTrust = {
    publicKey: simulator.publicKey,
    expectedInstanceId: INSTANCE,
    expectedVersion: '0.1.0',
    expectedSha: RELEASE_SHA,
    expectedNonce: NONCE,
    now: OBSERVED_AT + 30,
    maxAgeSeconds: 90,
  };
  const response = simulator.issue({
    observed_at: OBSERVED_AT,
    nonce: NONCE,
    status: 'healthy',
  });
  return { simulator, trust, response };
}

test('accepts only a signed, fresh ControlBot identity/version/SHA bound to challenge', () => {
  const { trust, response } = fixture();
  assert.deepEqual(assessControlBotHealth(response, trust), {
    status: 'OK',
    authenticated: true,
    reason: 'signed_fresh_health',
  });
  assert.deepEqual(response.payload, {
    version: 1,
    service: 'controlbot',
    instance_id: INSTANCE,
    release_version: '0.1.0',
    release_sha: RELEASE_SHA,
    observed_at: OBSERVED_AT,
    nonce: NONCE,
    status: 'healthy',
  });
  assert.match(response.signature, /^[A-Za-z0-9_-]{86}$/);
});

test('age boundary is deterministic; stale and future evidence never become OK', () => {
  const { trust, response } = fixture();
  assert.equal(assessControlBotHealth(response, { ...trust, now: OBSERVED_AT + 90 }).status, 'OK');
  assert.deepEqual(assessControlBotHealth(response, { ...trust, now: OBSERVED_AT + 91 }), {
    status: 'STALE',
    authenticated: true,
    reason: 'observation_expired',
  });
  assert.deepEqual(assessControlBotHealth(response, { ...trust, now: OBSERVED_AT - 1 }), {
    status: 'UNKNOWN',
    authenticated: true,
    reason: 'future_observation',
  });
  assert.equal(assessControlBotHealth(response, { ...trust, maxAgeSeconds: 0 }).status, 'UNKNOWN');
});

test('unsigned, malformed, changed or untrusted evidence fails closed', () => {
  const { simulator, trust, response } = fixture();
  const otherSimulator = createControlBotHealthSimulator({
    instance_id: INSTANCE,
    release_version: '0.1.0',
    release_sha: RELEASE_SHA,
  });
  const cases: unknown[] = [
    null,
    {},
    { payload: response.payload },
    { payload: response.payload, signature: '' },
    { payload: response.payload, signature: 'bogus' },
    { ...response, extra: true },
    { ...response, payload: { ...response.payload, extra: true } },
    { ...response, payload: { ...response.payload, release_sha: 'b'.repeat(40) } },
    { ...response, payload: { ...response.payload, observed_at: OBSERVED_AT + 1 } },
    { ...response, payload: { ...response.payload, status: 'degraded' } },
    { ...response, payload: { ...response.payload, version: 2 } },
  ];
  for (const candidate of cases) {
    const verdict = assessControlBotHealth(candidate, trust);
    assert.equal(verdict.status, 'UNKNOWN');
    assert.equal(verdict.authenticated, false);
  }
  assert.equal(assessControlBotHealth(response, {
    ...trust,
    publicKey: otherSimulator.publicKey,
  }).status, 'UNKNOWN');
  assert.equal(assessControlBotHealth(response, {
    ...trust,
    publicKey: simulator.publicKey,
    expectedInstanceId: '33333333-3333-7333-8333-333333333333',
  }).status, 'UNKNOWN');
});

test('a valid signature cannot change verifier-pinned version, SHA or nonce', () => {
  const { simulator, trust, response } = fixture();
  const mismatches: Partial<ControlBotHealthTrust>[] = [
    { expectedVersion: '0.1.1' },
    { expectedSha: 'b'.repeat(40) },
    { expectedNonce: '44444444-4444-7444-8444-444444444444' },
  ];
  for (const patch of mismatches) {
    assert.deepEqual(assessControlBotHealth(response, { ...trust, ...patch }), {
      status: 'UNKNOWN',
      authenticated: false,
      reason: 'identity_or_challenge_mismatch',
    });
  }
  const secondResponse = simulator.issue({
    observed_at: OBSERVED_AT,
    nonce: '55555555-5555-7555-8555-555555555555',
    status: 'healthy',
  });
  assert.equal(assessControlBotHealth(secondResponse, trust).status, 'UNKNOWN');
  assert.equal(assessControlBotHealth(secondResponse, {
    ...trust,
    expectedNonce: secondResponse.payload.nonce,
  }).status, 'OK');
});

test('signed degraded status is authenticated but not an OK readiness grant', () => {
  const { simulator, trust } = fixture();
  const response = simulator.issue({
    observed_at: OBSERVED_AT,
    nonce: NONCE,
    status: 'degraded',
  });
  assert.deepEqual(assessControlBotHealth(response, trust), {
    status: 'UNKNOWN',
    authenticated: true,
    reason: 'health_not_healthy',
  });
});

test('simulator has no network, persistent credentials or exposed signing key', () => {
  const { simulator, response, trust } = fixture();
  assert.deepEqual(Object.keys(simulator).sort(), ['issue', 'publicKey']);
  assert.equal(simulator.publicKey.type, 'public');
  assert.equal(JSON.stringify(response).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(response).includes('password'), false);
  assert.match(newHealthChallenge(), /^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
  assert.throws(() => simulator.issue({
    observed_at: OBSERVED_AT,
    nonce: NONCE,
    status: 'healthy',
    extra: 'unexpected',
  }), /campos inválidos/);
  const malicious = { ...response, payload: { ...response.payload, nonce: 'unexpected' } };
  assert.equal(assessControlBotHealth(malicious, trust).status, 'UNKNOWN');
});

test('returned snapshots cannot be used to bypass malformed trust or invalid signatures', () => {
  const { response, trust } = fixture();
  assert.equal(assessControlBotHealth(response as SignedControlBotHealth, {
    ...trust,
    expectedSha: 'not-a-sha',
  }).status, 'UNKNOWN');
  assert.equal(assessControlBotHealth(response, {
    ...trust,
    maxAgeSeconds: 86_401,
  }).status, 'UNKNOWN');
});
