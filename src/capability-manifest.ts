import { AdapterRegistry } from './adapters/programmatic.ts';
import type { ProgrammaticAdapterRegistration } from './adapters/programmatic.ts';
import { parseRunnerIdentity } from './runner.ts';
import type { RunnerIdentity } from './runner.ts';
import { stableSha256 } from './validation.ts';

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

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function registeredCapabilities(registrations: readonly ProgrammaticAdapterRegistration[]): string[] {
  const capabilities = registrations.flatMap((registration) => registration.capabilities);
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError('Capability registrada por más de un adapter.');
  }
  return capabilities.sort((a, b) => a.localeCompare(b, 'en'));
}

export function capabilityManifest(
  identityInput: unknown,
  registry: AdapterRegistry,
): CapabilityManifest {
  if (!(registry instanceof AdapterRegistry)) {
    throw new TypeError('AdapterRegistry inválido.');
  }

  const identity: RunnerIdentity = parseRunnerIdentity(identityInput);
  const registrations = registry.registrations();
  const capabilities = registeredCapabilities(registrations);

  if (!sameCapabilities(identity.capabilities, capabilities)) {
    throw new TypeError('Capability drift entre RunnerIdentity y AdapterRegistry.');
  }

  const adapters: CapabilityManifestAdapter[] = registrations.map((registration) => ({
    adapter_id: registration.adapter_id,
    capabilities: [...registration.capabilities],
  }));

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
