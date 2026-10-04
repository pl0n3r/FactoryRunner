import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, posix, resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  artifact: string;
  provenance: string;
  dependencies: string;
}>;

type PackageMetadata = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type ProvenanceFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 6) {
    fail(
      'Uso: check-observability-package-release-preflight.ts '
      + '--artifact <paquete.tgz> --provenance <provenance.json> '
      + '--dependencies <dependencies.json>',
    );
  }

  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--artifact', '--provenance', '--dependencies'].includes(key)
      || value === undefined
      || value.trim() === ''
      || parsed.has(key)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(key, value);
  }

  return {
    artifact: resolve(parsed.get('--artifact') as string),
    provenance: resolve(parsed.get('--provenance') as string),
    dependencies: resolve(parsed.get('--dependencies') as string),
  };
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ' inválido.');
  }
  return value as JsonObject;
}

function exactKeys(object: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(label + ' contiene campos desconocidos o incompletos.');
  }
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail(label + ' no contiene JSON válido.');
  }
}

function packageMetadata(value: unknown, label: string): PackageMetadata {
  const object = asObject(value, label);
  exactKeys(object, ['name', 'version', 'private', 'type'], label);
  if (
    typeof object.name !== 'string'
    || !object.name.startsWith('@pl0n3r/')
    || !PACKAGE_NAME_RE.test(object.name)
    || typeof object.version !== 'string'
    || !SEMVER_RE.test(object.version)
    || object.private !== true
    || object.type !== 'module'
  ) {
    fail(label + ' no tiene metadata canónica.');
  }

  return Object.freeze({
    name: object.name,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function canonicalPackagePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('*')
    || value.includes('?')
    || posix.normalize(value) !== value
    || value.split('/').some((part) => part === '' || part === '..' || part === '.')
  ) {
    fail(label + ' contiene una ruta no canónica.');
  }
  return value;
}

function safeSize(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    fail(label + ' contiene tamaño inválido.');
  }
  return value;
}

function shaValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail(label + ' contiene SHA-256 inválido.');
  }
  return value;
}

function validateExports(value: unknown): void {
  const exportsValue = asObject(value, 'provenance.package.exports');
  const keys = Object.keys(exportsValue);
  if (
    keys.length === 0
    || keys.some((key) => (
      key.trim() === ''
      || typeof exportsValue[key] !== 'string'
      || !(exportsValue[key] as string).startsWith('./')
      || (exportsValue[key] as string).includes('://')
    ))
  ) {
    fail('provenance.package.exports inválido.');
  }
}

function validateProvenance(value: unknown): {
  artifact: Readonly<{ filename: string; sha256: string; size: number }>;
  packageMetadata: PackageMetadata;
  allowlist: readonly string[];
  files: readonly ProvenanceFile[];
} {
  const root = asObject(value, 'provenance');
  exactKeys(
    root,
    [
      'schema_version',
      'artifact',
      'package',
      'allowlist',
      'files',
      'network_access',
      'external_mutation',
    ],
    'provenance',
  );
  if (
    root.schema_version !== 1
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('provenance fuera de la autoridad local permitida.');
  }

  const artifact = asObject(root.artifact, 'provenance.artifact');
  exactKeys(artifact, ['filename', 'sha256', 'size'], 'provenance.artifact');
  if (
    typeof artifact.filename !== 'string'
    || artifact.filename === ''
    || basename(artifact.filename) !== artifact.filename
    || !artifact.filename.endsWith('.tgz')
  ) {
    fail('Nombre de artefacto inválido.');
  }

  const packageValue = asObject(root.package, 'provenance.package');
  exactKeys(
    packageValue,
    ['name', 'version', 'private', 'type', 'exports'],
    'provenance.package',
  );
  validateExports(packageValue.exports);
  const metadata = packageMetadata(
    {
      name: packageValue.name,
      version: packageValue.version,
      private: packageValue.private,
      type: packageValue.type,
    },
    'provenance.package',
  );

  if (!Array.isArray(root.allowlist) || root.allowlist.length === 0) {
    fail('provenance.allowlist inválida.');
  }
  const allowlist = root.allowlist.map((entry) => (
    canonicalPackagePath(entry, 'provenance.allowlist')
  ));
  const sortedAllowlist = [...allowlist].sort(compareText);
  if (
    new Set(allowlist).size !== allowlist.length
    || allowlist.some((entry, index) => entry !== sortedAllowlist[index])
  ) {
    fail('provenance.allowlist no es única y ordenada.');
  }

  if (!Array.isArray(root.files) || root.files.length === 0) {
    fail('provenance.files inválido.');
  }
  const files = root.files.map((entry, index) => {
    const object = asObject(entry, 'provenance.files[' + index + ']');
    exactKeys(object, ['path', 'sha256', 'size'], 'provenance.files[' + index + ']');
    return Object.freeze({
      path: canonicalPackagePath(object.path, 'provenance.files[' + index + ']'),
      sha256: shaValue(object.sha256, 'provenance.files[' + index + ']'),
      size: safeSize(object.size, 'provenance.files[' + index + ']'),
    });
  });

  const paths = files.map((entry) => entry.path);
  const sortedPaths = [...paths].sort(compareText);
  if (
    new Set(paths).size !== paths.length
    || paths.some((entry, index) => entry !== sortedPaths[index])
  ) {
    fail('provenance.files no es único y ordenado.');
  }

  const expectedPaths = ['README.md', 'package.json', ...allowlist].sort(compareText);
  if (
    expectedPaths.length !== paths.length
    || expectedPaths.some((entry, index) => entry !== paths[index])
  ) {
    fail('provenance.files no coincide con la allowlist exacta.');
  }

  return {
    artifact: Object.freeze({
      filename: artifact.filename,
      sha256: shaValue(artifact.sha256, 'provenance.artifact'),
      size: safeSize(artifact.size, 'provenance.artifact'),
    }),
    packageMetadata: metadata,
    allowlist: Object.freeze(allowlist),
    files: Object.freeze(files),
  };
}

function validateDependencies(value: unknown): {
  packageMetadata: PackageMetadata;
  manifestSha256: string;
} {
  const root = asObject(value, 'dependency evidence');
  exactKeys(
    root,
    [
      'schema_version',
      'package',
      'source',
      'runtime_dependencies',
      'network_access',
      'external_mutation',
    ],
    'dependency evidence',
  );
  if (
    root.schema_version !== 1
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('dependency evidence fuera de la autoridad local permitida.');
  }

  const metadata = packageMetadata(root.package, 'dependency evidence.package');
  const source = asObject(root.source, 'dependency evidence.source');
  exactKeys(
    source,
    ['manifest_sha256', 'lockfile_sha256', 'lockfile_version'],
    'dependency evidence.source',
  );
  const manifestSha256 = shaValue(
    source.manifest_sha256,
    'dependency evidence.source.manifest_sha256',
  );
  shaValue(
    source.lockfile_sha256,
    'dependency evidence.source.lockfile_sha256',
  );
  if (source.lockfile_version !== 3) {
    fail('Versión de lockfile no soportada.');
  }

  if (!Array.isArray(root.runtime_dependencies)) {
    fail('dependency evidence.runtime_dependencies inválido.');
  }
  let previous = '';
  for (const [index, entry] of root.runtime_dependencies.entries()) {
    const object = asObject(
      entry,
      'dependency evidence.runtime_dependencies[' + index + ']',
    );
    exactKeys(
      object,
      ['name', 'specifier', 'locked_version'],
      'dependency evidence.runtime_dependencies[' + index + ']',
    );
    if (
      typeof object.name !== 'string'
      || !PACKAGE_NAME_RE.test(object.name)
      || typeof object.specifier !== 'string'
      || object.specifier.trim() === ''
      || object.specifier.includes('://')
      || typeof object.locked_version !== 'string'
      || !SEMVER_RE.test(object.locked_version)
      || (previous !== '' && compareText(previous, object.name) >= 0)
    ) {
      fail('Dependencia runtime no canónica.');
    }
    previous = object.name;
  }

  return {
    packageMetadata: metadata,
    manifestSha256,
  };
}

function equalPackage(left: PackageMetadata, right: PackageMetadata): boolean {
  return (
    left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type
  );
}

async function boundedRead(path: string, maximum: number, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum) {
    fail(label + ' inválido o fuera de límites.');
  }
  return await readFile(path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [artifactBody, provenanceBody, dependenciesBody] = await Promise.all([
    boundedRead(options.artifact, MAX_ARTIFACT_BYTES, 'Artefacto'),
    boundedRead(options.provenance, MAX_EVIDENCE_BYTES, 'Provenance'),
    boundedRead(options.dependencies, MAX_EVIDENCE_BYTES, 'Dependency evidence'),
  ]);

  const provenance = validateProvenance(
    parseJson(provenanceBody, 'Provenance'),
  );
  const dependencies = validateDependencies(
    parseJson(dependenciesBody, 'Dependency evidence'),
  );

  if (
    provenance.artifact.filename !== basename(options.artifact)
    || provenance.artifact.size !== artifactBody.length
    || provenance.artifact.sha256 !== sha256(artifactBody)
  ) {
    fail('El artefacto local no coincide exactamente con provenance.');
  }

  if (!equalPackage(provenance.packageMetadata, dependencies.packageMetadata)) {
    fail('La metadata del paquete diverge entre evidencias.');
  }

  const packageEntry = provenance.files.find((entry) => entry.path === 'package.json');
  if (
    packageEntry === undefined
    || packageEntry.sha256 !== dependencies.manifestSha256
  ) {
    fail('El package.json ligado por provenance no coincide con dependency evidence.');
  }

  process.stdout.write(
    JSON.stringify({
      accepted: true,
      artifact_sha256: provenance.artifact.sha256,
      package: provenance.packageMetadata,
      runtime_evidence_bound: true,
      network_access: false,
      external_mutation: false,
    }) + '\n',
  );
}

await main();
