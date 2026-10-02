import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdapterRegistry,
  capabilityManifest,
} from '../src/index.ts';
import type {
  ProgrammaticAdapter,
  ProgrammaticAdapterResult,
} from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';

class FakeAdapter implements ProgrammaticAdapter {
  readonly id: string;
  readonly capabilities: readonly string[];

  constructor(id: string, capabilities: readonly string[]) {
    this.id = id;
    this.capabilities = capabilities;
  }

  async execute(capability: string): Promise<ProgrammaticAdapterResult> {
    return {
      capability,
      data: { ok: true },
      evidence: { code: 'fake-ok', summary: 'Fake adapter executed', ref: null },
    };
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
    identity(['git.status', 'git.head']),
    new AdapterRegistry([
      new FakeAdapter('status-reader', ['git.status']),
      new FakeAdapter('head-reader', ['git.head']),
    ]),
  );
  const second = capabilityManifest(
    identity(['git.head', 'git.status']),
    new AdapterRegistry([
      new FakeAdapter('head-reader', ['git.head']),
      new FakeAdapter('status-reader', ['git.status']),
    ]),
  );

  assert.deepEqual(first, second);
  assert.deepEqual(first.capabilities, ['git.head', 'git.status']);
  assert.deepEqual(first.adapters, [
    { adapter_id: 'head-reader', capabilities: ['git.head'] },
    { adapter_id: 'status-reader', capabilities: ['git.status'] },
  ]);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.runner_id, runnerId);
  assert.equal(first.max_parallel, 4);
});

test('CapabilityManifest fails closed on capability drift or duplicate adapter mapping', () => {
  const registry = new AdapterRegistry([
    new FakeAdapter('git-reader', ['git.head']),
  ]);

  assert.throws(
    () => capabilityManifest(identity(['git.head', 'git.status']), registry),
    /Capability drift/,
  );
  assert.throws(
    () => capabilityManifest(identity(['git.status']), registry),
    /Capability drift/,
  );
  assert.throws(
    () => new AdapterRegistry([
      new FakeAdapter('git-a', ['git.head']),
      new FakeAdapter('git-b', ['git.head']),
    ]),
    /más de un adapter/,
  );
  assert.throws(
    () => new AdapterRegistry([
      new FakeAdapter('git-a', ['git.head', 'git.head']),
    ]),
    /capabilities duplicadas/,
  );
});
