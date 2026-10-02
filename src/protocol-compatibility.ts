import { parseRunnerIdentity, type RunnerIdentity } from './runner.ts';
import { asRecord, exactKeys, integer, slug, stableSha256, uuid } from './validation.ts';

export type ControlBotProtocolContract = {
  version: number;
  control_plane: string;
  execution_plane: string;
  protocol_version: number;
  client_contract_version: number;
  runner_id: string;
  capabilities: string[];
  freshness: 'fresh' | 'stale' | 'unknown';
  authority: 'unchanged';
};

export type ProtocolCompatibility = {
  version: 1;
  status: 'READY' | 'BLOCKED';
  compatible: boolean;
  authority: 'unchanged';
  runner_id: string | null;
  protocol_version: 1;
  client_contract_version: 1;
  reasons: string[];
  fingerprint: string;
};

type CompatibilityCore = Omit<ProtocolCompatibility, 'fingerprint'>;

const CONTRACT_KEYS = [
  'version',
  'control_plane',
  'execution_plane',
  'protocol_version',
  'client_contract_version',
  'runner_id',
  'capabilities',
  'freshness',
  'authority',
] as const;

function verdict(
  status: 'READY' | 'BLOCKED',
  runnerId: string | null,
  reasonsInput: readonly string[],
): ProtocolCompatibility {
  const reasons = [...new Set(reasonsInput)].sort((a, b) => a.localeCompare(b, 'en'));
  const core: CompatibilityCore = {
    version: 1,
    status,
    compatible: status === 'READY',
    authority: 'unchanged',
    runner_id: runnerId,
    protocol_version: 1,
    client_contract_version: 1,
    reasons,
  };
  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

function blocked(runnerId: string | null, reason: string): ProtocolCompatibility {
  return verdict('BLOCKED', runnerId, [reason]);
}

function normalizedCapabilities(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new TypeError('invalid_capabilities');
  }
  const capabilities = input.map((value) => slug(value, 'capability'));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError('duplicate_capabilities');
  }
  return capabilities.sort((a, b) => a.localeCompare(b, 'en'));
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseContract(input: unknown): ControlBotProtocolContract {
  const record = asRecord(input, 'ControlBotProtocolContract');
  exactKeys(record, CONTRACT_KEYS, 'ControlBotProtocolContract');

  const version = integer(record.version, 'version', 0, 1024);
  const protocolVersion = integer(record.protocol_version, 'protocol_version', 0, 1024);
  const clientContractVersion = integer(
    record.client_contract_version,
    'client_contract_version',
    0,
    1024,
  );
  const runnerId = uuid(record.runner_id, 'runner_id');
  const capabilities = normalizedCapabilities(record.capabilities);

  if (typeof record.control_plane !== 'string' || typeof record.execution_plane !== 'string') {
    throw new TypeError('invalid_plane_identity');
  }
  if (!['fresh', 'stale', 'unknown'].includes(String(record.freshness))) {
    throw new TypeError('invalid_freshness');
  }
  if (record.authority !== 'unchanged') {
    throw new TypeError('invalid_authority');
  }

  return {
    version,
    control_plane: record.control_plane,
    execution_plane: record.execution_plane,
    protocol_version: protocolVersion,
    client_contract_version: clientContractVersion,
    runner_id: runnerId,
    capabilities,
    freshness: record.freshness as ControlBotProtocolContract['freshness'],
    authority: 'unchanged',
  };
}

function compare(identity: RunnerIdentity, contract: ControlBotProtocolContract): string | null {
  if (contract.version !== 1) return 'unsupported_contract_envelope_version';
  if (contract.control_plane !== 'controlbot' || contract.execution_plane !== 'factoryrunner') {
    return 'protocol_identity_contradiction';
  }
  if (contract.freshness !== 'fresh') return 'protocol_contract_not_fresh';

  if (contract.protocol_version < identity.protocol_version) return 'protocol_downgrade';
  if (contract.protocol_version > identity.protocol_version) return 'protocol_version_unsupported';

  if (contract.client_contract_version < 1) return 'client_contract_downgrade';
  if (contract.client_contract_version > 1) return 'client_contract_version_unsupported';

  if (contract.runner_id !== identity.runner_id) return 'runner_identity_contradiction';
  if (!sameList(contract.capabilities, identity.capabilities)) {
    return 'capability_contract_contradiction';
  }
  return null;
}

export function protocolCompatibility(
  identityInput: unknown,
  contractInput: unknown,
): ProtocolCompatibility {
  let identity: RunnerIdentity;
  try {
    identity = parseRunnerIdentity(identityInput);
  } catch {
    return blocked(null, 'runner_identity_invalid');
  }

  let contract: ControlBotProtocolContract;
  try {
    contract = parseContract(contractInput);
  } catch {
    return blocked(identity.runner_id, 'controlbot_contract_invalid');
  }

  const incompatibility = compare(identity, contract);
  if (incompatibility !== null) {
    return blocked(identity.runner_id, incompatibility);
  }
  return verdict('READY', identity.runner_id, ['protocol_compatible']);
}
