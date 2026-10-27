import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserExecutionAdapter, BrowserExecutionError } from '../src/adapters/browser.ts';
import type { BrowserCapability } from '../src/adapters/browser.ts';
import {
  BrowserRemoteDriver,
  type BrowserRemoteTransport,
  type BrowserRemoteTransportRequest,
} from '../src/browser-remote-driver.ts';
import { browserRemoteOriginPolicy } from '../src/browser-remote-origin-policy.ts';
import { browserRemoteProfile } from '../src/browser-remote-profile.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const REF = 'browserref:offline-element-001';
const ORIGIN = 'https://example.test';
const REMOTE_ALIAS = 'offline-fixture';

type ResponseFactory = (request: BrowserRemoteTransportRequest) => unknown;

function fixture(capability: BrowserCapability, respond: ResponseFactory) {
  const policy = browserRemoteOriginPolicy([ORIGIN]);
  const profile = browserRemoteProfile({
    version: 1,
    runner_id: RUNNER_ID,
    location: 'hostinger-shared',
    capability,
    remote_alias: REMOTE_ALIAS,
  });
  const calls: BrowserRemoteTransportRequest[] = [];
  const transport: BrowserRemoteTransport = {
    async execute(request) {
      calls.push(structuredClone(request));
      return respond(request);
    },
  };
  const driver = new BrowserRemoteDriver(profile, transport);
  const adapter = new BrowserExecutionAdapter(driver, policy, {
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    location: 'hostinger-shared',
  });
  return { adapter, calls, policy, profile };
}

function response(
  request: BrowserRemoteTransportRequest,
  status: unknown,
) {
  return {
    version: 1,
    authority: 'unchanged',
    request_fingerprint: request.request_fingerprint,
    status,
    ref: null,
  };
}

const CAPABILITIES = [
  { capability: 'browser.navigate', input: { url: ORIGIN + '/safe' }, kind: 'navigate' },
  { capability: 'browser.click_ref', input: { ref: REF }, kind: 'click_ref' },
  { capability: 'browser.type_ref', input: { ref: REF, text: 'synthetic message' }, kind: 'type_ref' },
  { capability: 'browser.close', input: {}, kind: 'close' },
] as const;

test('CAPTCHA, MFA and rate limits stop every remote adapter with one request and unchanged identity', async () => {
  for (const challenge of ['CAPTCHA', 'MFA', 'RATE_LIMIT'] as const) {
    for (const { capability, input, kind } of CAPABILITIES) {
      const { adapter, calls, profile } = fixture(capability, (request) => response(request, 'blocked'));
      const result = await adapter.execute(capability, input);

      assert.deepEqual(result, { capability, status: 'blocked', ref: null }, challenge);
      assert.equal(calls.length, 1, challenge + ': no retry or second origin');
      const only = calls[0];
      assert.ok(only);
      assert.deepEqual(Object.keys(only).sort(), [
        'authority', 'capability', 'command', 'location', 'profile_fingerprint',
        'remote_alias', 'request_fingerprint', 'runner_id', 'version',
      ].sort());
      assert.equal(only.version, 1);
      assert.equal(only.authority, 'unchanged');
      assert.equal(only.capability, capability);
      assert.equal(only.command.kind, kind);
      assert.equal(only.runner_id, RUNNER_ID);
      assert.equal(only.location, 'hostinger-shared');
      assert.equal(only.remote_alias, REMOTE_ALIAS);
      assert.equal(only.profile_fingerprint, profile.fingerprint);
      assert.match(only.request_fingerprint, /^[0-9a-f]{64}$/);
      assert.match(only.command.session_key, /^browsersession:[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(only).includes(ORDER_ID), false);
      if (only.command.kind === 'navigate') {
        assert.equal(only.command.url, ORIGIN + '/safe');
      }
      assert.equal(Object.hasOwn(only.command, 'fallback_url'), false);
      assert.equal(Object.hasOwn(only.command, 'captcha_answer'), false);
      assert.equal(Object.hasOwn(only.command, 'retry'), false);
    }
  }
});

test('unknown, missing and malformed remote challenge responses fail closed without retry', async () => {
  for (const status of ['captcha', 'mfa', 'rate_limit', 'retry', 'ok_after_bypass', '', undefined]) {
    const { adapter, calls } = fixture('browser.navigate', (request) => response(request, status));
    await assert.rejects(
      () => adapter.execute('browser.navigate', { url: ORIGIN + '/safe' }),
      (error: unknown) => {
        assert.ok(error instanceof BrowserExecutionError);
        assert.equal(error.message, 'browser_execution_failed');
        return true;
      },
      'Unexpected challenge status must not become success.',
    );
    assert.equal(calls.length, 1, 'A malformed result cannot trigger evasive retries.');
  }

  for (const malformed of [
    (request: BrowserRemoteTransportRequest) => ({ ...response(request, 'blocked'), authority: 'elevated' }),
    (request: BrowserRemoteTransportRequest) => ({ ...response(request, 'blocked'), request_fingerprint: 'f'.repeat(64) }),
    (request: BrowserRemoteTransportRequest) => ({ ...response(request, 'blocked'), challenge_token: 'fixture-only' }),
    (request: BrowserRemoteTransportRequest) => ({ ...response(request, 'blocked'), ref: REF, alternate_origin: 'https://other.test' }),
    () => null,
    () => ({ status: 'blocked' }),
  ]) {
    const { adapter, calls } = fixture('browser.navigate', malformed);
    await assert.rejects(
      () => adapter.execute('browser.navigate', { url: ORIGIN + '/safe' }),
      (error: unknown) => error instanceof BrowserExecutionError && error.message === 'browser_execution_failed',
    );
    assert.equal(calls.length, 1, 'Unknown fields or absent provenance may not re-dispatch.');
  }
});

test('origin allowlist remains fixed despite a challenge or proposed alternate origin', async () => {
  for (const unsafeOrigin of [
    'http://example.test',
    'https://other.test/path',
    'https://person@example.test',
    'https://example.test?alternate=true',
    'https://example.test#fragment',
  ]) {
    assert.throws(() => browserRemoteOriginPolicy([unsafeOrigin]), TypeError);
  }

  const { adapter, calls, policy } = fixture('browser.navigate', (request) => response(request, 'blocked'));
  assert.deepEqual(policy, [ORIGIN]);
  assert.equal(Object.isFrozen(policy), true);

  for (const url of [
    'http://example.test/safe',
    'https://other.test/safe',
    'https://person@example.test/safe',
    'https://example.test/safe?retry=1',
    'https://example.test/safe#captcha',
    'https://example.test/a/../safe',
  ]) {
    await assert.rejects(() => adapter.execute('browser.navigate', { url }), TypeError);
  }
  await assert.rejects(() => adapter.execute('browser.eval', {}), TypeError);
  await assert.rejects(() => adapter.execute('browser.navigate', {
    url: ORIGIN + '/safe',
    alternative_origin: 'https://other.test',
  }), TypeError);
  assert.equal(calls.length, 0, 'Rejected input never reaches remote transport.');

  assert.deepEqual(
    await adapter.execute('browser.navigate', { url: ORIGIN + '/safe' }),
    { capability: 'browser.navigate', status: 'blocked', ref: null },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command.kind, 'navigate');
  assert.equal(policy.includes('https://other.test'), false);
});

test('remote transport failures are generic and never cause hidden retry or identity rotation', async () => {
  for (const { capability, input } of CAPABILITIES) {
    const { adapter, calls } = fixture(capability, () => {
      throw new Error('synthetic provider CAPTCHA/MFA/rate limit failure');
    });
    await assert.rejects(
      () => adapter.execute(capability, input),
      (error: unknown) => error instanceof BrowserExecutionError
        && error.message === 'browser_execution_failed'
        && !error.message.includes('provider'),
    );
    assert.equal(calls.length, 1, 'Failure must not trigger a second transport attempt.');
  }
});
