import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityManifest } from '../src/index.ts';
import type { CapabilityAdapterSource } from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';

class FakeAdapter implements CapabilityAdapterSource {
  readonly id: string;
  readonly capabilities: readonly string[];

  constructor(id: string, capabilities: readonly string[]) {
    this.id = id;
    this.capabilities = capabilities;
  }
}

function identity(capabilities: string[]) {
  return {
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities,
    max_parallel: 4,
  };
}

test('CapabilityManifest is derived from identity and registered adapters', () => {
  const first = capabilityManifest(
    identity(['browser.navigate', 'git.head', 'git.status']),
    [
      new FakeAdapter('git-read', ['git.status', 'git.head']),
      new FakeAdapter('browser-execution', ['browser.navigate']),
    ],
  );
  const second = capabilityManifest(
    identity(['git.status', 'browser.navigate', 'git.head']),
    [
      new FakeAdapter('browser-execution', ['browser.navigate']),
      new FakeAdapter('git-read', ['git.head', 'git.status']),
    ],
  );

  assert.deepEqual(first, second);
  assert.deepEqual(first.capabilities, ['browser.navigate', 'git.head', 'git.status']);
  assert.deepEqual(first.adapters, [
    { adapter_id: 'browser-execution', capabilities: ['browser.navigate'] },
    { adapter_id: 'git-read', capabilities: ['git.head', 'git.status'] },
  ]);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.runner_id, runnerId);
  assert.equal(first.max_parallel, 4);
});

test('CapabilityManifest fails closed on capability drift or duplicate adapter mapping', () => {
  const adapters = [new FakeAdapter('git-read', ['git.head'])];

  assert.throws(
    () => capabilityManifest(identity(['git.head', 'git.status']), adapters),
    /Capability drift/,
  );
  assert.throws(
    () => capabilityManifest(identity(['git.status']), adapters),
    /Capability drift/,
  );
  assert.throws(
    () => capabilityManifest(identity(['git.head']), [
      new FakeAdapter('git-a', ['git.head']),
      new FakeAdapter('git-b', ['git.head']),
    ]),
    /más de un adapter/,
  );
  assert.throws(
    () => capabilityManifest(identity(['git.head']), [
      new FakeAdapter('git-a', ['git.head', 'git.head']),
    ]),
    /capabilities duplicadas/,
  );
  assert.throws(
    () => capabilityManifest(identity(['git.head', 'git.status']), [
      new FakeAdapter('git-a', ['git.head']),
      new FakeAdapter('git-a', ['git.status']),
    ]),
    /Adapter id duplicado/,
  );
});
