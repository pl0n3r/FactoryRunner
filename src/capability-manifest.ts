import { parseRunnerIdentity } from './runner.ts';
import type { RunnerIdentity } from './runner.ts';
import { capability, slug, stableSha256 } from './validation.ts';

export type CapabilityAdapterSource = {
  readonly id: string;
  readonly capabilities: readonly string[];
};

export type CapabilityManifestAdapter = {
  adapter_id: string;
  capabilities: string[];
};

export type CapabilityManifest = {
  version: 1;
  runner_id: string;
  protocol_version: 1;
  runtime: string;
  runtime_version: string;
  platform: string;
  location: string;
  max_parallel: number;
  capabilities: string[];
  adapters: CapabilityManifestAdapter[];
  fingerprint: string;
};

type CapabilityManifestCore = Omit<CapabilityManifest, 'fingerprint'>;

function normalizeAdapters(
  adaptersInput: readonly CapabilityAdapterSource[],
): CapabilityManifestAdapter[] {
  if (!Array.isArray(adaptersInput) || adaptersInput.length === 0 || adaptersInput.length > 64) {
    throw new TypeError('Adapters registrados inválidos.');
  }

  const adapterIds = new Set<string>();
  const capabilityOwners = new Map<string, string>();
  const adapters: CapabilityManifestAdapter[] = [];

  for (const adapter of adaptersInput) {
    if (adapter === null || typeof adapter !== 'object') {
      throw new TypeError('Adapter registrado inválido.');
    }

    const adapterId = slug(adapter.id, 'adapter.id');
    if (adapterIds.has(adapterId)) {
      throw new TypeError('Adapter id duplicado.');
    }
    adapterIds.add(adapterId);

    if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
      throw new TypeError('Adapter sin capabilities.');
    }

    const capabilities = adapter.capabilities.map((value: unknown) => capability(value, 'capability'));
    if (new Set(capabilities).size !== capabilities.length) {
      throw new TypeError('Adapter contiene capabilities duplicadas.');
    }

    capabilities.sort((a: string, b: string) => a.localeCompare(b, 'en'));
    for (const capability of capabilities) {
      if (capabilityOwners.has(capability)) {
        throw new TypeError('Capability registrada por más de un adapter.');
      }
      capabilityOwners.set(capability, adapterId);
    }

    adapters.push({ adapter_id: adapterId, capabilities });
  }

  adapters.sort((a, b) => a.adapter_id.localeCompare(b.adapter_id, 'en'));
  return adapters;
}

function manifestCapabilities(adapters: readonly CapabilityManifestAdapter[]): string[] {
  return adapters
    .flatMap((adapter) => adapter.capabilities)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function capabilityManifest(
  identityInput: unknown,
  adaptersInput: readonly CapabilityAdapterSource[],
): CapabilityManifest {
  const identity: RunnerIdentity = parseRunnerIdentity(identityInput);
  const adapters = normalizeAdapters(adaptersInput);
  const capabilities = manifestCapabilities(adapters);

  if (!sameCapabilities(identity.capabilities, capabilities)) {
    throw new TypeError('Capability drift entre RunnerIdentity y adapters registrados.');
  }

  const core: CapabilityManifestCore = {
    version: 1,
    runner_id: identity.runner_id,
    protocol_version: identity.protocol_version,
    runtime: identity.runtime,
    runtime_version: identity.runtime_version,
    platform: identity.platform,
    location: identity.location,
    max_parallel: identity.max_parallel,
    capabilities: [...capabilities],
    adapters,
  };

  return {
    ...core,
    fingerprint: stableSha256(core),
  };
}
