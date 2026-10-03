import {
  browserRemoteObservabilityManifest,
  type BrowserRemoteObservabilityExportName,
  type BrowserRemoteObservabilityManifest,
} from './browser-remote-observability-manifest.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  stringValue,
} from './validation.ts';

export type BrowserRemoteObservabilityRequirement = Readonly<{
  export_name: string;
  contract_version: number;
}>;

export type BrowserRemoteObservabilityConsumer = Readonly<{
  version: 1;
  manifest_version: number;
  required_exports: readonly BrowserRemoteObservabilityRequirement[];
}>;

export type BrowserRemoteObservabilityCompatibilityReason =
  | 'CONSUMER_INVALID'
  | 'EXPORT_UNSUPPORTED'
  | 'EXPORT_VERSION_UNSUPPORTED'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_VERSION_UNSUPPORTED';

export type BrowserRemoteObservabilityCompatibility = Readonly<{
  version: 1;
  authority: 'unchanged';
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: readonly BrowserRemoteObservabilityCompatibilityReason[];
  manifest_fingerprint: string | null;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type CompatibilityCore = Omit<
  BrowserRemoteObservabilityCompatibility,
  'fingerprint'
>;

const CONSUMER_KEYS = [
  'version',
  'manifest_version',
  'required_exports',
] as const;
const REQUIREMENT_KEYS = ['export_name', 'contract_version'] as const;
const MANIFEST_KEYS = ['version', 'authority', 'exports', 'fingerprint'] as const;
const EXPORT_KEYS = ['export_name', 'contract_version'] as const;
const EXPORT_NAMES = new Set<string>(
  browserRemoteObservabilityManifest().exports.map((entry) => entry.export_name),
);
const SHA256_RE = /^[0-9a-f]{64}$/;

function manifest(input: unknown): BrowserRemoteObservabilityManifest {
  const record = asRecord(input, 'BrowserRemoteObservabilityManifest');
  exactKeys(record, MANIFEST_KEYS, 'BrowserRemoteObservabilityManifest');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || !Array.isArray(record.exports)
  ) {
    throw new TypeError('BrowserRemoteObservabilityManifest inválido.');
  }

  const exports = record.exports.map((value, index) => {
    const entry = asRecord(value, `manifest.exports[${index}]`);
    exactKeys(entry, EXPORT_KEYS, `manifest.exports[${index}]`);
    const exportName = stringValue(
      entry.export_name,
      `manifest.exports[${index}].export_name`,
      80,
    );
    if (!EXPORT_NAMES.has(exportName) || entry.contract_version !== 1) {
      throw new TypeError('Manifest contiene export/version desconocido.');
    }
    return Object.freeze({
      export_name: exportName as BrowserRemoteObservabilityExportName,
      contract_version: 1 as const,
    });
  });

  const names = exports.map((entry) => entry.export_name);
  const sorted = [...names].sort((left, right) => left.localeCompare(right, 'en'));
  if (
    names.length !== EXPORT_NAMES.size
    || new Set(names).size !== names.length
    || names.some((name, index) => name !== sorted[index])
  ) {
    throw new TypeError('Manifest no es canónico.');
  }

  const fingerprint = stringValue(record.fingerprint, 'manifest.fingerprint', 64);
  if (!SHA256_RE.test(fingerprint)) {
    throw new TypeError('Manifest fingerprint inválido.');
  }
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    exports: Object.freeze(exports),
  });
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('Manifest fingerprint incoherente.');
  }

  const canonical = browserRemoteObservabilityManifest();
  if (stableSha256(record) !== stableSha256(canonical)) {
    throw new TypeError('Manifest no coincide con el contrato canónico.');
  }
  return canonical;
}

function consumer(input: unknown): BrowserRemoteObservabilityConsumer {
  const record = asRecord(input, 'BrowserRemoteObservabilityConsumer');
  exactKeys(record, CONSUMER_KEYS, 'BrowserRemoteObservabilityConsumer');
  if (record.version !== 1 || !Array.isArray(record.required_exports)) {
    throw new TypeError('Consumer inválido.');
  }

  const manifestVersion = integer(
    record.manifest_version,
    'consumer.manifest_version',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const requirements = record.required_exports.map((value, index) => {
    const item = asRecord(value, `consumer.required_exports[${index}]`);
    exactKeys(item, REQUIREMENT_KEYS, `consumer.required_exports[${index}]`);
    return Object.freeze({
      export_name: stringValue(
        item.export_name,
        `consumer.required_exports[${index}].export_name`,
        80,
      ),
      contract_version: integer(
        item.contract_version,
        `consumer.required_exports[${index}].contract_version`,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    });
  });

  const names = requirements.map((item) => item.export_name);
  if (
    requirements.length === 0
    || new Set(names).size !== names.length
  ) {
    throw new TypeError('Consumer required_exports inválidos.');
  }

  return Object.freeze({
    version: 1,
    manifest_version: manifestVersion,
    required_exports: Object.freeze(requirements),
  });
}

function result(
  reasonsInput: readonly BrowserRemoteObservabilityCompatibilityReason[],
  manifestFingerprint: string | null,
): BrowserRemoteObservabilityCompatibility {
  const reasons = Object.freeze(
    [...new Set(reasonsInput)].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core: CompatibilityCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    status: reasons.length === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE',
    reasons,
    manifest_fingerprint: manifestFingerprint,
    network_access: false,
    external_mutation: false,
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

export function browserRemoteObservabilityCompatibility(
  manifestInput: unknown,
  consumerInput: unknown,
): BrowserRemoteObservabilityCompatibility {
  let parsedManifest: BrowserRemoteObservabilityManifest;
  try {
    parsedManifest = manifest(manifestInput);
  } catch {
    return result(['MANIFEST_INVALID'], null);
  }

  let parsedConsumer: BrowserRemoteObservabilityConsumer;
  try {
    parsedConsumer = consumer(consumerInput);
  } catch {
    return result(['CONSUMER_INVALID'], parsedManifest.fingerprint);
  }

  const reasons: BrowserRemoteObservabilityCompatibilityReason[] = [];
  if (parsedConsumer.manifest_version !== parsedManifest.version) {
    reasons.push('MANIFEST_VERSION_UNSUPPORTED');
  }

  const supported = new Map<string, number>(
    parsedManifest.exports.map((entry) => [entry.export_name, entry.contract_version]),
  );
  for (const requirement of parsedConsumer.required_exports) {
    const version = supported.get(requirement.export_name);
    if (version === undefined) {
      reasons.push('EXPORT_UNSUPPORTED');
    } else if (version !== requirement.contract_version) {
      reasons.push('EXPORT_VERSION_UNSUPPORTED');
    }
  }

  return result(reasons, parsedManifest.fingerprint);
}
