import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  receipt: string;
  artifact: string;
  provenance: string;
  dependencies: string;
  preflight: string;
}>;

type Receipt = Readonly<{
  package: Readonly<{ name: string; version: string }>;
  artifact: Readonly<{ filename: string; sha256: string; size: number }>;
  evidence: Readonly<{
    provenance_sha256: string;
    dependency_evidence_sha256: string;
    preflight_contract_sha256: string;
    preflight_result_sha256: string;
  }>;
}>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({
  receipt: 4096,
  artifact: 32 * 1024 * 1024,
  evidence: 4 * 1024 * 1024,
  preflight: 1024 * 1024,
  builderOutput: 4096,
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
      'Uso: check-observability-package-release-receipt.ts '
      + '--receipt <receipt.json> --artifact <paquete.tgz> '
      + '--provenance <provenance.json> --dependencies <dependencies.json> '
      + '--preflight <script.ts>',
    );
  }

  const accepted = new Set([
    '--receipt',
    '--artifact',
    '--provenance',
    '--dependencies',
    '--preflight',
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
    receipt: resolve(values.get('--receipt') as string),
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
    preflight: resolve(values.get('--preflight') as string),
  });
}

async function boundedRegularRead(
  path: string,
  maximum: number,
  label: string,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > maximum
  ) {
    fail(label + ' inválido, no regular o fuera de límites.');
  }
  return readFile(path);
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

function parseCanonicalReceipt(body: Buffer): Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail('receipt: JSON inválido.');
  }

  const canonical = JSON.stringify(canonicalValue(parsed), null, 2) + '\n';
  if (body.toString('utf8') !== canonical) {
    fail('receipt: representación JSON no canónica.');
  }

  const root = exactObject(parsed, 'receipt', [
    'schema_version',
    'package',
    'artifact',
    'evidence',
    'verification',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('receipt: autoridad o versión inválida.');
  }

  const packageValue = exactObject(
    root.package,
    'receipt.package',
    ['name', 'version', 'private', 'type'],
  );
  if (
    typeof packageValue.name !== 'string'
    || !packageValue.name.startsWith('@pl0n3r/')
    || !PACKAGE_RE.test(packageValue.name)
    || typeof packageValue.version !== 'string'
    || !VERSION_RE.test(packageValue.version)
    || packageValue.private !== true
    || packageValue.type !== 'module'
  ) {
    fail('receipt.package: identidad inválida.');
  }

  const artifact = exactObject(
    root.artifact,
    'receipt.artifact',
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
    fail('receipt.artifact: metadata inválida.');
  }

  const evidence = exactObject(root.evidence, 'receipt.evidence', [
    'provenance_sha256',
    'dependency_evidence_sha256',
    'preflight_contract_sha256',
    'preflight_result_sha256',
  ]);
  for (const field of [
    'provenance_sha256',
    'dependency_evidence_sha256',
    'preflight_contract_sha256',
    'preflight_result_sha256',
  ] as const) {
    if (typeof evidence[field] !== 'string' || !SHA256_RE.test(evidence[field] as string)) {
      fail('receipt.evidence: fingerprint inválido.');
    }
  }

  const verification = exactObject(root.verification, 'receipt.verification', [
    'preflight_passed',
    'runtime_evidence_bound',
    'network_access',
    'external_mutation',
  ]);
  if (
    verification.preflight_passed !== true
    || verification.runtime_evidence_bound !== true
    || verification.network_access !== false
    || verification.external_mutation !== false
  ) {
    fail('receipt.verification: estado inválido.');
  }

  return Object.freeze({
    package: Object.freeze({
      name: packageValue.name,
      version: packageValue.version,
    }),
    artifact: Object.freeze({
      filename: artifact.filename,
      sha256: artifact.sha256,
      size: artifact.size,
    }),
    evidence: Object.freeze({
      provenance_sha256: evidence.provenance_sha256 as string,
      dependency_evidence_sha256: evidence.dependency_evidence_sha256 as string,
      preflight_contract_sha256: evidence.preflight_contract_sha256 as string,
      preflight_result_sha256: evidence.preflight_result_sha256 as string,
    }),
  });
}

async function regenerateExpected(options: Options): Promise<Buffer> {
  const builder = resolve(
    process.cwd(),
    'scripts',
    'create-observability-package-release-receipt.ts',
  );
  const builderMetadata = await lstat(builder);
  if (builderMetadata.isSymbolicLink() || !builderMetadata.isFile()) {
    fail('builder canónico inválido.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'factoryrunner-receipt-verify-'));
  const output = join(directory, 'expected.json');
  try {
    const completed = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        builder,
        '--artifact',
        options.artifact,
        '--provenance',
        options.provenance,
        '--dependencies',
        options.dependencies,
        '--preflight',
        options.preflight,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: LIMITS.preflight,
      },
    );
    if (completed.error !== undefined || completed.status !== 0) {
      fail('No fue posible regenerar el receipt canónico.');
    }
    return await boundedRegularRead(output, LIMITS.builderOutput, 'receipt esperado');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [receiptBody, artifactBody, provenanceBody, dependenciesBody, preflightBody] = await Promise.all([
    boundedRegularRead(options.receipt, LIMITS.receipt, 'receipt'),
    boundedRegularRead(options.artifact, LIMITS.artifact, 'artifact'),
    boundedRegularRead(options.provenance, LIMITS.evidence, 'provenance'),
    boundedRegularRead(options.dependencies, LIMITS.evidence, 'dependencies'),
    boundedRegularRead(options.preflight, LIMITS.preflight, 'preflight'),
  ]);

  const receipt = parseCanonicalReceipt(receiptBody);
  if (
    receipt.artifact.filename !== basename(options.artifact)
    || receipt.artifact.size !== artifactBody.length
    || receipt.artifact.sha256 !== sha256(artifactBody)
    || receipt.evidence.provenance_sha256 !== sha256(provenanceBody)
    || receipt.evidence.dependency_evidence_sha256 !== sha256(dependenciesBody)
    || receipt.evidence.preflight_contract_sha256 !== sha256(preflightBody)
  ) {
    fail('receipt: bindings locales no coinciden.');
  }

  const expected = await regenerateExpected(options);
  if (!receiptBody.equals(expected)) {
    fail('receipt: contenido no coincide con la regeneración canónica.');
  }

  process.stdout.write(JSON.stringify({
    verified: true,
    receipt_sha256: sha256(receiptBody),
    artifact_sha256: receipt.artifact.sha256,
    package: receipt.package,
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
