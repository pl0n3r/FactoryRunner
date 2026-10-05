import {
  executionRecoveryHandoffPublicManifest,
  type ExecutionRecoveryHandoffPublicExportName,
  type ExecutionRecoveryHandoffPublicManifest,
} from './execution-recovery-handoff-public-manifest.ts';
import { asRecord, exactKeys, stableSha256, stringValue } from './validation.ts';

export type ExecutionRecoveryHandoffPublicCompatibilityReason =
  | 'CONTRACT_MISSING'
  | 'MANIFEST_INVALID'
  | 'REQUIREMENTS_INVALID'
  | 'VERSION_MISMATCH';

export type ExecutionRecoveryHandoffPublicRequirement = Readonly<{
  export_name: ExecutionRecoveryHandoffPublicExportName;
  contract_version: 1;
}>;

export type ExecutionRecoveryHandoffPublicCompatibility = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: readonly ExecutionRecoveryHandoffPublicCompatibilityReason[];
  manifest_fingerprint: string | null;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type CompatibilityCore = Omit<ExecutionRecoveryHandoffPublicCompatibility, 'fingerprint'>;
type ParsedRequirement = Readonly<{
  export_name: string;
  contract_version: number;
}>;

const MANIFEST_KEYS = [
  'version',
  'authority',
  'exports',
  'execution',
  'network_access',
  'external_mutation',
  'fingerprint',
] as const;
const REQUIREMENT_KEYS = ['export_name', 'contract_version'] as const;
const MAX_REQUIREMENTS = 64;

function canonicalManifest(input: unknown): ExecutionRecoveryHandoffPublicManifest {
  const record = asRecord(input, 'ExecutionRecoveryHandoffPublicManifest');
  exactKeys(record, MANIFEST_KEYS, 'ExecutionRecoveryHandoffPublicManifest');

  const expected = executionRecoveryHandoffPublicManifest();
  if (stableSha256(record) !== stableSha256(expected)) {
    throw new TypeError('ExecutionRecoveryHandoffPublicManifest no es canónico.');
  }
  return expected;
}

function canonicalRequirements(input: unknown): readonly ParsedRequirement[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REQUIREMENTS) {
    throw new TypeError('requirements inválidos.');
  }

  const parsed = input.map((value, index) => {
    const record = asRecord(value, `requirements[${index}]`);
    exactKeys(record, REQUIREMENT_KEYS, `requirements[${index}]`);

    const exportName = stringValue(
      record.export_name,
      `requirements[${index}].export_name`,
      80,
    );
    if (
      !Number.isSafeInteger(record.contract_version)
      || (record.contract_version as number) < 1
      || (record.contract_version as number) > 1_000_000
    ) {
      throw new TypeError(`requirements[${index}].contract_version inválida.`);
    }

    return Object.freeze({
      export_name: exportName,
      contract_version: record.contract_version as number,
    });
  });

  if (new Set(parsed.map((item) => item.export_name)).size !== parsed.length) {
    throw new TypeError('requirements contiene contratos duplicados.');
  }

  return Object.freeze(
    [...parsed].sort((left, right) => left.export_name.localeCompare(right.export_name, 'en')),
  );
}

function result(
  reasonsInput: readonly ExecutionRecoveryHandoffPublicCompatibilityReason[],
  manifestFingerprint: string | null,
): ExecutionRecoveryHandoffPublicCompatibility {
  const reasons = Object.freeze(
    [...new Set(reasonsInput)].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core: CompatibilityCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: reasons.length === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE',
    reasons,
    manifest_fingerprint: manifestFingerprint,
    execution: false,
    network_access: false,
    external_mutation: false,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionRecoveryHandoffPublicCompatibility(
  manifestInput: unknown,
  requirementsInput: unknown,
): ExecutionRecoveryHandoffPublicCompatibility {
  const reasons: ExecutionRecoveryHandoffPublicCompatibilityReason[] = [];

  let manifest: ExecutionRecoveryHandoffPublicManifest | null = null;
  try {
    manifest = canonicalManifest(manifestInput);
  } catch {
    reasons.push('MANIFEST_INVALID');
  }

  let requirements: readonly ParsedRequirement[] | null = null;
  try {
    requirements = canonicalRequirements(requirementsInput);
  } catch {
    reasons.push('REQUIREMENTS_INVALID');
  }

  if (manifest !== null && requirements !== null) {
    const contracts = new Map(
      manifest.exports.map((entry) => [entry.export_name, entry.contract_version] as const),
    );

    for (const requirement of requirements) {
      const supportedVersion = contracts.get(
        requirement.export_name as ExecutionRecoveryHandoffPublicExportName,
      );
      if (supportedVersion === undefined) {
        reasons.push('CONTRACT_MISSING');
        continue;
      }
      if (requirement.contract_version !== supportedVersion) {
        reasons.push('VERSION_MISMATCH');
      }
    }
  }

  return result(reasons, manifest?.fingerprint ?? null);
}
