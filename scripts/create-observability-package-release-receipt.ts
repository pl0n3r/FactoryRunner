import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  artifact: string;
  provenance: string;
  dependencies: string;
  preflight: string;
  output: string;
}>;

type PackageCore = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type PreflightResult = Readonly<{
  accepted: true;
  artifact_sha256: string;
  package: PackageCore;
  runtime_evidence_bound: true;
  network_access: false;
  external_mutation: false;
}>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({
  artifact: 32 * 1024 * 1024,
  evidence: 4 * 1024 * 1024,
  preflight: 1024 * 1024,
  receipt: 4096,
});

function fail(message: string): never {
  throw new Error(message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 10) {
    fail(
      'Uso: create-observability-package-release-receipt.ts '
      + '--artifact <paquete.tgz> --provenance <provenance.json> '
      + '--dependencies <dependencies.json> --preflight <script.ts> '
      + '--output <receipt.json>',
    );
  }

  const accepted = new Set([
    '--artifact',
    '--provenance',
    '--dependencies',
    '--preflight',
    '--output',
  ]);
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !accepted.has(key)
      || value === undefined
      || value.trim() === ''
      || values.has(key)
    ) {
      fail('Argumentos inválidos.');
    }
    values.set(key, value);
  }

  for (const key of accepted) {
    if (!values.has(key)) fail('Falta argumento requerido: ' + key);
  }

  return Object.freeze({
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
    preflight: resolve(values.get('--preflight') as string),
    output: resolve(values.get('--output') as string),
  });
}

async function boundedRead(path: string, maximum: number, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum) {
    fail(label + ' inválido o fuera de límites.');
  }
  return readFile(path);
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail(label + ' no contiene JSON válido.');
  }
}

function exactObject(value: unknown, label: string, fields: readonly string[]): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ': objeto requerido.');
  }
  const object = value as JsonObject;
  const actual = Object.keys(object).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(label + ': schema desconocido o incompleto.');
  }
  return object;
}

function packageCore(value: unknown, label: string, withExports: boolean): PackageCore {
  const fields = withExports
    ? ['name', 'version', 'private', 'type', 'exports']
    : ['name', 'version', 'private', 'type'];
  const object = exactObject(value, label, fields);
  if (
    typeof object.name !== 'string'
    || !object.name.startsWith('@pl0n3r/')
    || !PACKAGE_RE.test(object.name)
    || typeof object.version !== 'string'
    || !VERSION_RE.test(object.version)
    || object.private !== true
    || object.type !== 'module'
  ) {
    fail(label + ': identidad de paquete inválida.');
  }
  if (withExports) {
    if (
      typeof object.exports !== 'object'
      || object.exports === null
      || Array.isArray(object.exports)
      || Object.keys(object.exports as JsonObject).length === 0
      || Object.values(object.exports as JsonObject).some((entry) => (
        typeof entry !== 'string'
        || !entry.startsWith('./')
        || entry.includes('://')
      ))
    ) {
      fail(label + ': exports inválidos.');
    }
  }
  return Object.freeze({
    name: object.name,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function inspectProvenance(value: unknown): Readonly<{
  package: PackageCore;
  artifact: Readonly<{ filename: string; sha256: string; size: number }>;
}> {
  const root = exactObject(value, 'provenance', [
    'schema_version',
    'artifact',
    'package',
    'allowlist',
    'files',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.schema_version !== 1
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('provenance: autoridad local inválida.');
  }

  const artifact = exactObject(
    root.artifact,
    'provenance.artifact',
    ['filename', 'sha256', 'size'],
  );
  if (
    typeof artifact.filename !== 'string'
    || basename(artifact.filename) !== artifact.filename
    || !artifact.filename.endsWith('.tgz')
    || typeof artifact.sha256 !== 'string'
    || !SHA256_RE.test(artifact.sha256)
    || typeof artifact.size !== 'number'
    || !Number.isSafeInteger(artifact.size)
    || artifact.size <= 0
  ) {
    fail('provenance.artifact: metadata inválida.');
  }

  if (!Array.isArray(root.allowlist) || !Array.isArray(root.files)) {
    fail('provenance: listas requeridas ausentes.');
  }

  return Object.freeze({
    package: packageCore(root.package, 'provenance.package', true),
    artifact: Object.freeze({
      filename: artifact.filename,
      sha256: artifact.sha256,
      size: artifact.size,
    }),
  });
}

function inspectDependencies(value: unknown): PackageCore {
  const root = exactObject(value, 'dependencies', [
    'schema_version',
    'package',
    'source',
    'runtime_dependencies',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.schema_version !== 1
    || root.network_access !== false
    || root.external_mutation !== false
    || !Array.isArray(root.runtime_dependencies)
  ) {
    fail('dependencies: evidencia local inválida.');
  }
  const source = exactObject(
    root.source,
    'dependencies.source',
    ['manifest_sha256', 'lockfile_sha256', 'lockfile_version'],
  );
  if (
    typeof source.manifest_sha256 !== 'string'
    || !SHA256_RE.test(source.manifest_sha256)
    || typeof source.lockfile_sha256 !== 'string'
    || !SHA256_RE.test(source.lockfile_sha256)
    || source.lockfile_version !== 3
  ) {
    fail('dependencies.source: metadata inválida.');
  }
  return packageCore(root.package, 'dependencies.package', false);
}

function inspectPreflightResult(value: unknown): PreflightResult {
  const root = exactObject(value, 'preflight result', [
    'accepted',
    'artifact_sha256',
    'package',
    'runtime_evidence_bound',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.accepted !== true
    || root.runtime_evidence_bound !== true
    || root.network_access !== false
    || root.external_mutation !== false
    || typeof root.artifact_sha256 !== 'string'
    || !SHA256_RE.test(root.artifact_sha256)
  ) {
    fail('preflight result: resultado local inválido.');
  }
  return Object.freeze({
    accepted: true,
    artifact_sha256: root.artifact_sha256,
    package: packageCore(root.package, 'preflight result.package', false),
    runtime_evidence_bound: true,
    network_access: false,
    external_mutation: false,
  });
}

function samePackage(left: PackageCore, right: PackageCore): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value === 'object' && value !== null) {
    const object = value as JsonObject;
    const result: JsonObject = {};
    for (const key of Object.keys(object).sort(compareText)) {
      result[key] = canonicalValue(object[key]);
    }
    return result;
  }
  fail('Valor no serializable.');
}

function parseCanonicalJson(body: Buffer, label: string): unknown {
  const parsed = parseJson(body, label);
  const canonical = JSON.stringify(canonicalValue(parsed), null, 2) + '\n';
  if (body.toString('utf8') !== canonical) {
    fail(label + ': representación JSON no canónica.');
  }
  return parsed;
}

function verifyPreflightScript(path: string): void {
  const expected = resolve(
    process.cwd(),
    'scripts',
    'check-observability-package-release-preflight.ts',
  );
  if (path !== expected) {
    fail('preflight: solo se permite el contrato local canónico.');
  }
}

function runPreflight(options: Options): Readonly<{
  result: PreflightResult;
  stdout: string;
}> {
  const completed = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      options.preflight,
      '--artifact',
      options.artifact,
      '--provenance',
      options.provenance,
      '--dependencies',
      options.dependencies,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: LIMITS.preflight,
    },
  );

  if (
    completed.error !== undefined
    || completed.status !== 0
    || typeof completed.stdout !== 'string'
    || Buffer.byteLength(completed.stdout, 'utf8') <= 0
    || Buffer.byteLength(completed.stdout, 'utf8') > LIMITS.preflight
  ) {
    fail('preflight: validación local rechazada.');
  }

  const parsed = parseJson(Buffer.from(completed.stdout, 'utf8'), 'preflight result');
  return Object.freeze({
    result: inspectPreflightResult(parsed),
    stdout: completed.stdout,
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  verifyPreflightScript(options.preflight);

  const [artifactBody, provenanceBody, dependenciesBody, preflightBody] = await Promise.all([
    boundedRead(options.artifact, LIMITS.artifact, 'artifact'),
    boundedRead(options.provenance, LIMITS.evidence, 'provenance'),
    boundedRead(options.dependencies, LIMITS.evidence, 'dependencies'),
    boundedRead(options.preflight, LIMITS.preflight, 'preflight'),
  ]);

  const provenance = inspectProvenance(parseCanonicalJson(provenanceBody, 'provenance'));
  const dependencies = inspectDependencies(parseCanonicalJson(dependenciesBody, 'dependencies'));
  if (!samePackage(provenance.package, dependencies)) {
    fail('Evidencias pertenecen a paquetes distintos.');
  }

  const artifactHash = sha256(artifactBody);
  if (
    provenance.artifact.filename !== basename(options.artifact)
    || provenance.artifact.sha256 !== artifactHash
    || provenance.artifact.size !== artifactBody.length
  ) {
    fail('Artifact no coincide con provenance.');
  }

  const preflight = runPreflight(options);
  if (
    preflight.result.artifact_sha256 !== artifactHash
    || !samePackage(preflight.result.package, provenance.package)
    || !samePackage(preflight.result.package, dependencies)
  ) {
    fail('preflight result: evidencia mezclada o divergente.');
  }

  const receipt = {
    schema_version: 1,
    package: provenance.package,
    artifact: {
      filename: provenance.artifact.filename,
      sha256: artifactHash,
      size: artifactBody.length,
    },
    evidence: {
      provenance_sha256: sha256(provenanceBody),
      dependency_evidence_sha256: sha256(dependenciesBody),
      preflight_contract_sha256: sha256(preflightBody),
      preflight_result_sha256: sha256(preflight.stdout),
    },
    verification: {
      preflight_passed: true,
      runtime_evidence_bound: true,
      network_access: false,
      external_mutation: false,
    },
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  };

  const serialized = JSON.stringify(canonicalValue(receipt), null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.receipt) {
    fail('receipt fuera de límites.');
  }
  await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'wx' });
}

await main();
