import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilityManifest } from '../src/capability-manifest.ts';
import { executionAdmissionDecision } from '../src/execution-admission.ts';
import { stableSha256 } from '../src/validation.ts';

// FR465/RM-14: all identities, orders and observations are synthetic.
// This contract never starts the Runner, contacts ControlBot or uses a provider.
const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const now = 1_210;

function identity(capabilities = ['git.head']) {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.5',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: [...capabilities],
    max_parallel: 1,
  };
}

function order(capability = 'git.head') {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:625',
    runner_id: runnerId,
    capability,
    attempt: 1,
    issued_at: 1_100,
    expires_at: 1_300,
    instruction_ref: 'controlbot:instruction:factoryrunner-625',
  };
}

function resource() {
  return {
    version: 1,
    runner_id: runnerId,
    observed_at: 1_200,
    heartbeat_sequence: 3,
    runner_status: 'ready',
    max_parallel: 1,
    active: 0,
    available: 1,
    queued_orders: 1,
    dispatchable_orders: 1,
    freshness: 'fresh',
    age_seconds: 10,
    stale_after_seconds: 30,
  };
}

const registered = [{ id: 'git-read', capabilities: ['git.head'] }];
const manifest = capabilityManifest(identity(), registered);

function admission(identityInput: unknown, orderInput: unknown, manifestInput: unknown, resourceInput: unknown = resource()) {
  return executionAdmissionDecision(identityInput, orderInput, manifestInput, resourceInput, now);
}

function assertBlocked(decision: ReturnType<typeof executionAdmissionDecision>) {
  assert.equal(decision.decision, 'BLOCKED');
  assert.equal(decision.authority, 'unchanged');
  assert.ok(decision.reasons.includes('admission_evidence_invalid'));
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.reasons));
  assert.match(decision.fingerprint, /^[0-9a-f]{64}$/);
  const { fingerprint, ...core } = decision;
  assert.equal(stableSha256(core), fingerprint);
  assert.doesNotMatch(JSON.stringify(decision), /instruction_ref|adapters|credential|password/i);
}

test('only registered adapter capabilities enter a coherent manifest and admission', () => {
  const before = JSON.stringify(manifest);
  const decision = admission(identity(), order(), manifest);
  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.authority, 'unchanged');
  assert.deepEqual(decision.reasons, ['admission_evidence_coherent']);
  assert.equal(decision.runner_id, runnerId);
  assert.equal(decision.order_id, orderId);
  assert.equal(decision.manifest_fingerprint, manifest.fingerprint);
  assert.deepEqual(manifest.capabilities, ['git.head']);
  assert.deepEqual(manifest.adapters, [{ adapter_id: 'git-read', capabilities: ['git.head'] }]);
  assert.equal(JSON.stringify(manifest), before);
});

test('unregistered execution requests are rejected, recorded and never expand manifest', () => {
  const before = JSON.stringify(manifest);
  for (const capability of ['browser.navigate', 'git.status', 'network.forward']) {
    const result = admission(identity(), order(capability), manifest);
    assertBlocked(result);
    assert.equal(result.order_id, orderId);
    assert.equal(result.manifest_fingerprint, manifest.fingerprint);
    assert.equal(result.order_fingerprint, stableSha256(order(capability)));
  }
  assert.equal(JSON.stringify(manifest), before);
});

test('identity and adapter capability drift cannot self-authorize execution', () => {
  const expandedIdentity = identity(['git.head', 'browser.navigate']);
  // A runner claiming a new capability without a registered adapter is not authority.
  assertBlocked(admission(expandedIdentity, order('browser.navigate'), manifest));
  assertBlocked(admission(expandedIdentity, order(), manifest));
  assert.throws(
    () => capabilityManifest(expandedIdentity, registered),
    /Capability drift/,
  );
  assert.throws(
    () => capabilityManifest(identity(), [
      ...registered,
      { id: 'browser', capabilities: ['browser.navigate'] },
    ]),
    /Capability drift/,
  );

  // A modified manifest must not survive its fingerprint binding.
  const injected = {
    ...manifest,
    capabilities: [...manifest.capabilities, 'browser.navigate'],
    adapters: [...manifest.adapters, { adapter_id: 'browser', capabilities: ['browser.navigate'] }],
  };
  assertBlocked(admission(identity(), order('browser.navigate'), injected));

  // Even a freshly recomputed fingerprint is not a registration grant.
  const { fingerprint: _old, ...core } = injected;
  const forged = { ...core, fingerprint: stableSha256(core) };
  assertBlocked(admission(identity(), order('browser.navigate'), forged));
});

test('incoherent and ambiguous authority fails closed with immutable reason evidence', () => {
  const malformed: Array<[unknown, unknown, unknown, unknown]> = [
    [null, order(), manifest, resource()],
    [identity(), null, manifest, resource()],
    [identity(), order(), null, resource()],
    [identity(), order(), manifest, null],
    [identity(), order(), { ...manifest, fingerprint: '0'.repeat(64) }, resource()],
    [identity(), order(), { ...manifest, capabilities: undefined }, resource()],
    [identity(), order(), { ...manifest, unexpected_scope: 'browser.navigate' }, resource()],
    [identity(), order(), manifest, { ...resource(), freshness: 'stale' }],
    [identity(), order(), manifest, { ...resource(), available: 2 }],
    [identity(), { ...order(), runner_id: '99999999-9999-7999-8999-999999999999' }, manifest, resource()],
    [identity(), { ...order(), capability: undefined }, manifest, resource()],
  ];
  for (const [id, command, capabilities, resources] of malformed) {
    assertBlocked(admission(id, command, capabilities, resources));
  }
  assert.deepEqual(manifest.capabilities, ['git.head']);
});

test('resource unavailability does not convert into ALLOW or increase authority', () => {
  const full = resource();
  const wait = admission(identity(), order(), manifest, {
    ...full,
    runner_status: 'busy',
    active: 1,
    available: 0,
    dispatchable_orders: 0,
  });
  assert.equal(wait.decision, 'WAIT_CAPACITY');
  assert.equal(wait.authority, 'unchanged');
  assert.deepEqual(wait.reasons, ['capacity_unavailable']);
  assert.equal(wait.manifest_fingerprint, manifest.fingerprint);
  const draining = admission(identity(), order(), manifest, {
    ...full,
    runner_status: 'draining',
    available: 0,
    dispatchable_orders: 0,
  });
  assert.equal(draining.decision, 'BLOCKED');
  assert.deepEqual(draining.reasons, ['runner_not_dispatchable']);
  assert.equal(draining.authority, 'unchanged');
});
