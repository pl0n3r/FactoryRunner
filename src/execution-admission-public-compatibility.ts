import {
  executionAdmissionPublicManifest,
  type ExecutionAdmissionPublicExportName,
  type ExecutionAdmissionPublicManifest,
} from './execution-admission-public-manifest.ts';
import { asRecord, exactKeys, stableSha256, stringValue } from './validation.ts';

export type ExecutionAdmissionPublicCompatibilityReason =
  | 'CONTRACT_MISSING'
  | 'MANIFEST_INVALID'
  | 'REQUIREMENTS_INVALID'
  | 'VERSION_MISMATCH';

export type ExecutionAdmissionPublicRequirement = Readonly<{
  export_name: ExecutionAdmissionPublicExportName;
  contract_version: 1;
}>;

export type ExecutionAdmissionPublicCompatibility = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: readonly ExecutionAdmissionPublicCompatibilityReason[];
  manifest_fingerprint: string | null;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type ParsedRequirement = Readonly<{ export_name: string; contract_version: number }>;
const MANIFEST_FIELDS = Object.freeze([
  'version',
  'authority',
  'exports',
  'execution',
  'network_access',
  'external_mutation',
  'fingerprint',
]);
const REQUIREMENT_FIELDS = Object.freeze(['export_name', 'contract_version']);
const SAFE_RESULT = Object.freeze({
  version: 1 as const,
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function readManifest(value: unknown): ExecutionAdmissionPublicManifest | null {
  try {
    const record = asRecord(value, 'ExecutionAdmissionPublicManifest');
    exactKeys(record, MANIFEST_FIELDS, 'ExecutionAdmissionPublicManifest');
    const expected = executionAdmissionPublicManifest();
    return stableSha256(record) === stableSha256(expected) ? expected : null;
  } catch {
    return null;
  }
}

function readRequirements(value: unknown): readonly ParsedRequirement[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;

  try {
    const seen = new Set<string>();
    const parsed: ParsedRequirement[] = [];
    for (const [index, item] of value.entries()) {
      const record = asRecord(item, `requirements[${index}]`);
      exactKeys(record, REQUIREMENT_FIELDS, `requirements[${index}]`);
      const export_name = stringValue(record.export_name, `requirements[${index}].export_name`, 80);
      const contract_version = record.contract_version;
      if (
        !Number.isSafeInteger(contract_version)
        || (contract_version as number) < 1
        || (contract_version as number) > 1_000_000
        || seen.has(export_name)
      ) return null;

      seen.add(export_name);
      parsed.push(Object.freeze({ export_name, contract_version: contract_version as number }));
    }
    parsed.sort((left, right) => left.export_name.localeCompare(right.export_name, 'en'));
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function buildResult(
  reasons: Set<ExecutionAdmissionPublicCompatibilityReason>,
  manifestFingerprint: string | null,
): ExecutionAdmissionPublicCompatibility {
  const orderedReasons = Object.freeze(
    [...reasons].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core = Object.freeze({
    ...SAFE_RESULT,
    status: orderedReasons.length === 0 ? 'COMPATIBLE' as const : 'INCOMPATIBLE' as const,
    reasons: orderedReasons,
    manifest_fingerprint: manifestFingerprint,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function executionAdmissionPublicCompatibility(
  manifestInput: unknown,
  requirementsInput: unknown,
): ExecutionAdmissionPublicCompatibility {
  const manifest = readManifest(manifestInput);
  const requirements = readRequirements(requirementsInput);
  const reasons = new Set<ExecutionAdmissionPublicCompatibilityReason>();

  if (manifest === null) reasons.add('MANIFEST_INVALID');
  if (requirements === null) reasons.add('REQUIREMENTS_INVALID');

  if (manifest !== null && requirements !== null) {
    const supported = new Map(
      manifest.exports.map(({ export_name, contract_version }) => [export_name, contract_version] as const),
    );
    for (const requirement of requirements) {
      const version = supported.get(requirement.export_name as ExecutionAdmissionPublicExportName);
      if (version === undefined) reasons.add('CONTRACT_MISSING');
      else if (version !== requirement.contract_version) reasons.add('VERSION_MISMATCH');
    }
  }

  return buildResult(reasons, manifest?.fingerprint ?? null);
}
