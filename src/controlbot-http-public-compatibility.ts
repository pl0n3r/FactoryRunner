import {
  controlBotHttpPublicManifest,
  type ControlBotHttpPublicExportName,
  type ControlBotHttpPublicManifest,
} from './controlbot-http-public-manifest.ts';
import { asRecord, exactKeys, integer, stableSha256, stringValue } from './validation.ts';

export type ControlBotHttpPublicCompatibilityReason =
  | 'CONTRACT_MISSING'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'FENCING_MISMATCH'
  | 'MANIFEST_INVALID'
  | 'PROTOCOL_MISMATCH'
  | 'REQUIREMENTS_INVALID'
  | 'SAFETY_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'SUBPATH_MISMATCH'
  | 'SURFACE_MISMATCH'
  | 'VERSION_MISMATCH';

export type ControlBotHttpPublicRequirement = Readonly<{
  export_name: string;
  contract_version: number;
  capability: string;
}>;

export type ControlBotHttpPublicRequirements = Readonly<{
  version: number;
  subpath: string;
  protocol_version: number;
  fencing: string;
  session_transport: string;
  authority: string;
  execution: boolean;
  network_access: boolean;
  external_mutation: boolean;
  required_exports: readonly ControlBotHttpPublicRequirement[];
}>;

export type ControlBotHttpPublicCompatibility = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: readonly ControlBotHttpPublicCompatibilityReason[];
  manifest_fingerprint: string | null;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type ParsedRequirement = Readonly<{
  export_name: string;
  contract_version: number;
  capability: string;
}>;

type ParsedRequirements = Readonly<{
  version: number;
  subpath: string;
  protocol_version: number;
  fencing: string;
  session_transport: string;
  authority: string;
  execution: boolean;
  network_access: boolean;
  external_mutation: boolean;
  required_exports: readonly ParsedRequirement[];
}>;

const MANIFEST_KEYS = [
  'version',
  'subpath',
  'protocol_version',
  'fencing',
  'session_transport',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
  'exports',
  'fingerprint',
] as const;
const REQUIREMENTS_KEYS = [
  'version',
  'subpath',
  'protocol_version',
  'fencing',
  'session_transport',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
  'required_exports',
] as const;
const EXPORT_KEYS = ['export_name', 'contract_version', 'capability'] as const;
const MAX_REQUIREMENTS = 64;
const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function canonicalManifest(input: unknown): ControlBotHttpPublicManifest {
  const record = asRecord(input, 'ControlBotHttpPublicManifest');
  exactKeys(record, MANIFEST_KEYS, 'ControlBotHttpPublicManifest');

  const expected = controlBotHttpPublicManifest();
  if (stableSha256(record) !== stableSha256(expected)) {
    throw new TypeError('ControlBotHttpPublicManifest no es canónico.');
  }
  return expected;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} inválido.`);
  return value;
}

function requirements(input: unknown): ParsedRequirements {
  const record = asRecord(input, 'ControlBotHttpPublicRequirements');
  exactKeys(record, REQUIREMENTS_KEYS, 'ControlBotHttpPublicRequirements');
  if (!Array.isArray(record.required_exports)) {
    throw new TypeError('required_exports inválido.');
  }

  const entries = record.required_exports;
  if (entries.length === 0 || entries.length > MAX_REQUIREMENTS) {
    throw new TypeError('required_exports fuera de límites.');
  }

  const parsed = entries.map((value, index) => {
    const item = asRecord(value, `required_exports[${index}]`);
    exactKeys(item, EXPORT_KEYS, `required_exports[${index}]`);
    return Object.freeze({
      export_name: stringValue(
        item.export_name,
        `required_exports[${index}].export_name`,
        80,
      ),
      contract_version: integer(
        item.contract_version,
        `required_exports[${index}].contract_version`,
        1,
        1_000_000,
      ),
      capability: stringValue(
        item.capability,
        `required_exports[${index}].capability`,
        32,
      ),
    });
  });

  if (new Set(parsed.map((item) => item.export_name)).size !== parsed.length) {
    throw new TypeError('required_exports contiene exports duplicados.');
  }

  return Object.freeze({
    version: integer(record.version, 'version', 1, 1_000_000),
    subpath: stringValue(record.subpath, 'subpath', 80),
    protocol_version: integer(record.protocol_version, 'protocol_version', 1, 1_000_000),
    fencing: stringValue(record.fencing, 'fencing', 32),
    session_transport: stringValue(record.session_transport, 'session_transport', 64),
    authority: stringValue(record.authority, 'authority', 32),
    execution: booleanValue(record.execution, 'execution'),
    network_access: booleanValue(record.network_access, 'network_access'),
    external_mutation: booleanValue(record.external_mutation, 'external_mutation'),
    required_exports: Object.freeze(parsed),
  });
}

function result(
  reasonsInput: readonly ControlBotHttpPublicCompatibilityReason[],
  manifestFingerprint: string | null,
): ControlBotHttpPublicCompatibility {
  const reasons = Object.freeze(
    [...new Set(reasonsInput)].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core = Object.freeze({
    version: 1 as const,
    ...SAFETY,
    status: reasons.length === 0 ? 'COMPATIBLE' as const : 'INCOMPATIBLE' as const,
    reasons,
    manifest_fingerprint: manifestFingerprint,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function controlBotHttpPublicCompatibility(
  manifestInput: unknown,
  requirementsInput: unknown,
): ControlBotHttpPublicCompatibility {
  const reasons: ControlBotHttpPublicCompatibilityReason[] = [];

  let manifest: ControlBotHttpPublicManifest | null = null;
  try {
    manifest = canonicalManifest(manifestInput);
  } catch {
    reasons.push('MANIFEST_INVALID');
  }

  let requested: ParsedRequirements | null = null;
  try {
    requested = requirements(requirementsInput);
  } catch {
    reasons.push('REQUIREMENTS_INVALID');
  }

  if (manifest !== null && requested !== null) {
    if (requested.version !== manifest.version) reasons.push('VERSION_MISMATCH');
    if (requested.subpath !== manifest.subpath) reasons.push('SUBPATH_MISMATCH');
    if (requested.protocol_version !== manifest.protocol_version) reasons.push('PROTOCOL_MISMATCH');
    if (requested.fencing !== manifest.fencing) reasons.push('FENCING_MISMATCH');
    if (requested.session_transport !== manifest.session_transport) reasons.push('SESSION_MISMATCH');
    if (
      requested.authority !== manifest.authority
      || requested.execution !== manifest.execution
      || requested.network_access !== manifest.network_access
      || requested.external_mutation !== manifest.external_mutation
    ) {
      reasons.push('SAFETY_MISMATCH');
    }

    const supported = new Map(
      manifest.exports.map((entry) => [entry.export_name, entry] as const),
    );
    const requiredNames = new Set<string>();
    for (const requirement of requested.required_exports) {
      requiredNames.add(requirement.export_name);
      const contract = supported.get(requirement.export_name as ControlBotHttpPublicExportName);
      if (contract === undefined) {
        reasons.push('CONTRACT_MISSING');
        continue;
      }
      if (requirement.contract_version !== contract.contract_version) {
        reasons.push('CONTRACT_VERSION_MISMATCH');
      }
      if (requirement.capability !== contract.capability) {
        reasons.push('SURFACE_MISMATCH');
      }
    }

    if (
      requested.required_exports.length !== manifest.exports.length
      || manifest.exports.some((entry) => !requiredNames.has(entry.export_name))
    ) {
      reasons.push('CONTRACT_MISSING');
    }
  }

  return result(reasons, manifest?.fingerprint ?? null);
}
