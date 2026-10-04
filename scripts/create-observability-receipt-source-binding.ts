import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type PackageIdentity = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type Options = Readonly<{
  verifiedReceipt: string;
  sourceSnapshot: string;
  output: string;
}>;

const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({
  verifiedReceipt: 4096,
  sourceSnapshot: 64 * 1024,
  output: 4096,
  files: 256,
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

function exactObject(
  value: unknown,
  label: string,
  fields: readonly string[],
): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label}: objeto requerido.`);
  }
  const record = value as JsonObject;
  const allowed = new Set(fields);
  const present = Object.keys(record);
  if (
    present.length !== allowed.size
    || present.some((key) => !allowed.has(key))
  ) {
    fail(`${label}: schema desconocido o incompleto.`);
  }
  return record;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Valor no serializable.');
    return value;
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  fail('Valor no serializable.');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value), null, 2) + '\n';
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail(label + ': JSON inválido.');
  }
}

function parseCanonicalJson(body: Buffer, label: string): unknown {
  const parsed = parseJson(body, label);
  if (body.toString('utf8') !== canonicalJson(parsed)) {
    fail(label + ': representación JSON no canónica.');
  }
  return parsed;
}

function packageIdentity(value: unknown, label: string): PackageIdentity {
  const object = exactObject(
    value,
    label,
    ['name', 'version', 'private', 'type'],
  );
  if (
    typeof object.name !== 'string'
    || !object.name.startsWith('@pl0n3r/')
    || !PACKAGE_RE.test(object.name)
    || typeof object.version !== 'string'
    || !VERSION_RE.test(object.version)
    || object.private !== true
    || object.type !== 'module'
  ) {
    fail(label + ': identidad inválida.');
  }
  return Object.freeze({
    name: object.name,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function samePackage(left: PackageIdentity, right: PackageIdentity): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 6) fail('Argumentos inválidos.');
  const accepted = new Set(['--verified-receipt', '--source-snapshot', '--output']);
  const parsed: Record<string, string> = {};

  for (let cursor = 0; cursor < argv.length; cursor += 2) {
    const flag = argv[cursor];
    const candidate = argv[cursor + 1];
    if (
      !accepted.has(flag)
      || candidate === undefined
      || candidate.trim().length === 0
      || Object.hasOwn(parsed, flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed[flag] = candidate;
  }

  const receipt = parsed['--verified-receipt'];
  const snapshot = parsed['--source-snapshot'];
  const output = parsed['--output'];
  if (receipt === undefined || snapshot === undefined || output === undefined) {
    fail('Falta input requerido.');
  }
  return Object.freeze({
    verifiedReceipt: resolve(receipt),
    sourceSnapshot: resolve(snapshot),
    output: resolve(output),
  });
}

async function localBytes(
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
    fail(label + ': archivo local inválido.');
  }
  return readFile(path);
}

function verifiedReceipt(value: unknown): Readonly<{
  package: PackageIdentity;
  receiptSha256: string;
  artifactSha256: string;
}> {
  const root = exactObject(value, 'verified receipt', [
    'verified',
    'receipt_sha256',
    'artifact_sha256',
    'package',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.verified !== true
    || root.authority !== 'unchanged'
    || root.network_access !== false
    || root.external_mutation !== false
    || typeof root.receipt_sha256 !== 'string'
    || !SHA256_RE.test(root.receipt_sha256)
    || typeof root.artifact_sha256 !== 'string'
    || !SHA256_RE.test(root.artifact_sha256)
  ) {
    fail('verified receipt: evidencia inválida.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'verified receipt.package'),
    receiptSha256: root.receipt_sha256,
    artifactSha256: root.artifact_sha256,
  });
}

function canonicalPath(path: string): string {
  if (
    path === ''
    || path.startsWith('/')
    || path.includes('\\')
    || posix.normalize(path) !== path
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('source snapshot: ruta no canónica.');
  }
  return path;
}

function sourceSnapshot(value: unknown): Readonly<{
  package: PackageIdentity;
  commitSha: string;
  treeSha: string;
  sourceSha256: string;
}> {
  const root = exactObject(value, 'source snapshot', [
    'schema_version',
    'package',
    'repository',
    'source',
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
    fail('source snapshot: authority inválida.');
  }

  const repository = exactObject(
    root.repository,
    'source snapshot.repository',
    ['ref', 'commit_sha', 'tree_sha'],
  );
  if (
    repository.ref !== 'refs/heads/main'
    || typeof repository.commit_sha !== 'string'
    || !SHA1_RE.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1_RE.test(repository.tree_sha)
  ) {
    fail('source snapshot.repository: identidad inválida.');
  }

  const verification = exactObject(
    root.verification,
    'source snapshot.verification',
    ['exact_main', 'worktree_clean', 'tracked_sources'],
  );
  if (
    verification.exact_main !== true
    || verification.worktree_clean !== true
    || verification.tracked_sources !== true
  ) {
    fail('source snapshot: verificación exact-main ausente.');
  }

  const source = exactObject(
    root.source,
    'source snapshot.source',
    ['sha256', 'files'],
  );
  if (
    typeof source.sha256 !== 'string'
    || !SHA256_RE.test(source.sha256)
    || !Array.isArray(source.files)
    || source.files.length === 0
    || source.files.length > LIMITS.files
  ) {
    fail('source snapshot.source: evidencia inválida.');
  }

  const seen = new Set<string>();
  let previous = '';
  for (const rawFile of source.files) {
    const file = exactObject(
      rawFile,
      'source snapshot.source.files[]',
      ['path', 'sha256', 'size'],
    );
    if (
      typeof file.path !== 'string'
      || canonicalPath(file.path) !== file.path
      || seen.has(file.path)
      || (previous !== '' && compareText(previous, file.path) >= 0)
      || typeof file.sha256 !== 'string'
      || !SHA256_RE.test(file.sha256)
      || typeof file.size !== 'number'
      || !Number.isSafeInteger(file.size)
      || file.size <= 0
    ) {
      fail('source snapshot.source.files: entrada inválida.');
    }
    seen.add(file.path);
    previous = file.path;
  }

  const fingerprint = sha256(canonicalJson(source.files));
  if (fingerprint !== source.sha256) {
    fail('source snapshot.source: fingerprint divergente.');
  }

  return Object.freeze({
    package: packageIdentity(root.package, 'source snapshot.package'),
    commitSha: repository.commit_sha,
    treeSha: repository.tree_sha,
    sourceSha256: source.sha256,
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [receiptBody, snapshotBody] = await Promise.all([
    localBytes(
      options.verifiedReceipt,
      LIMITS.verifiedReceipt,
      'verified receipt',
    ),
    localBytes(
      options.sourceSnapshot,
      LIMITS.sourceSnapshot,
      'source snapshot',
    ),
  ]);

  const receipt = verifiedReceipt(parseJson(receiptBody, 'verified receipt'));
  const snapshot = sourceSnapshot(
    parseCanonicalJson(snapshotBody, 'source snapshot'),
  );
  if (!samePackage(receipt.package, snapshot.package)) {
    fail('Binding rechazado: receipt y source pertenecen a paquetes distintos.');
  }

  const binding = {
    schema_version: 1,
    package: receipt.package,
    receipt: {
      sha256: receipt.receiptSha256,
      artifact_sha256: receipt.artifactSha256,
    },
    source_snapshot: {
      sha256: sha256(snapshotBody),
      source_sha256: snapshot.sourceSha256,
      commit_sha: snapshot.commitSha,
      tree_sha: snapshot.treeSha,
    },
    verification: {
      receipt_verified: true,
      source_exact_main: true,
      package_match: true,
    },
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  };

  const serialized = canonicalJson(binding);
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.output) {
    fail('Binding fuera de límites.');
  }
  await writeFile(options.output, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

await main();
