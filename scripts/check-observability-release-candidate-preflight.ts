import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

type JObject = Record<string, unknown>;

type PackageId = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type Evidence<T> = Readonly<{ bytes: Buffer; value: T }>;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX = Object.freeze({
  receipt: 4096,
  snapshot: 64 * 1024,
  binding: 4096,
  output: 4096,
});

function reject(message: string): never {
  throw new Error(message);
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordOf(value: unknown, label: string): JObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    reject(`${label}: objeto requerido.`);
  }
  return value as JObject;
}

function requireShape(
  value: unknown,
  label: string,
  expected: readonly string[],
): JObject {
  const object = recordOf(value, label);
  const keys = Object.keys(object);
  const wanted = new Set(expected);
  if (keys.length !== wanted.size || keys.some((key) => !wanted.has(key))) {
    reject(`${label}: schema no reconocido.`);
  }
  return object;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JObject)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

function pretty(value: unknown): string {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

async function readEvidence(
  path: string,
  limit: number,
  label: string,
  canonical: boolean,
): Promise<Evidence<unknown>> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > limit) {
    reject(`${label}: archivo inválido o fuera de límites.`);
  }
  const bytes = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    reject(`${label}: JSON inválido.`);
  }
  if (canonical && bytes.toString('utf8') !== pretty(value)) {
    reject(`${label}: JSON no canónico.`);
  }
  return Object.freeze({ bytes, value });
}

function packageId(value: unknown, label: string): PackageId {
  const item = requireShape(value, label, ['name', 'version', 'private', 'type']);
  if (
    typeof item.name !== 'string'
    || !item.name.startsWith('@pl0n3r/')
    || !PACKAGE.test(item.name)
    || typeof item.version !== 'string'
    || !VERSION.test(item.version)
    || item.private !== true
    || item.type !== 'module'
  ) {
    reject(`${label}: identidad de paquete inválida.`);
  }
  return Object.freeze({
    name: item.name,
    version: item.version,
    private: true,
    type: 'module',
  });
}

function packageEqual(left: PackageId, right: PackageId): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

function inspectReceipt(value: unknown): Readonly<{
  package: PackageId;
  receiptSha: string;
  artifactSha: string;
}> {
  const root = requireShape(value, 'verified receipt', [
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
    || !SHA256.test(root.receipt_sha256)
    || typeof root.artifact_sha256 !== 'string'
    || !SHA256.test(root.artifact_sha256)
  ) {
    reject('verified receipt: evidencia rechazada.');
  }
  return Object.freeze({
    package: packageId(root.package, 'verified receipt.package'),
    receiptSha: root.receipt_sha256,
    artifactSha: root.artifact_sha256,
  });
}

function inspectSnapshot(value: unknown): Readonly<{
  package: PackageId;
  commit: string;
  tree: string;
  sourceSha: string;
}> {
  const root = requireShape(value, 'source snapshot', [
    'schema_version',
    'package',
    'repository',
    'source',
    'verification',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  const repository = requireShape(
    root.repository,
    'source snapshot.repository',
    ['ref', 'commit_sha', 'tree_sha'],
  );
  const source = requireShape(root.source, 'source snapshot.source', ['sha256', 'files']);
  const verification = requireShape(
    root.verification,
    'source snapshot.verification',
    ['exact_main', 'tracked_sources', 'worktree_clean'],
  );

  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.network_access !== false
    || root.external_mutation !== false
    || repository.ref !== 'refs/heads/main'
    || typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || verification.exact_main !== true
    || verification.tracked_sources !== true
    || verification.worktree_clean !== true
    || typeof source.sha256 !== 'string'
    || !SHA256.test(source.sha256)
    || !Array.isArray(source.files)
    || source.files.length === 0
    || digest(pretty(source.files)) !== source.sha256
  ) {
    reject('source snapshot: evidencia exact-main inválida.');
  }

  return Object.freeze({
    package: packageId(root.package, 'source snapshot.package'),
    commit: repository.commit_sha,
    tree: repository.tree_sha,
    sourceSha: source.sha256,
  });
}

function inspectBinding(value: unknown): Readonly<{
  package: PackageId;
  receiptSha: string;
  artifactSha: string;
  snapshotSha: string;
  sourceSha: string;
  commit: string;
  tree: string;
}> {
  const root = requireShape(value, 'binding', [
    'schema_version',
    'package',
    'receipt',
    'source_snapshot',
    'verification',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  const receipt = requireShape(root.receipt, 'binding.receipt', ['sha256', 'artifact_sha256']);
  const source = requireShape(root.source_snapshot, 'binding.source_snapshot', [
    'sha256',
    'source_sha256',
    'commit_sha',
    'tree_sha',
  ]);
  const verification = requireShape(root.verification, 'binding.verification', [
    'receipt_verified',
    'source_exact_main',
    'package_match',
  ]);

  const hashes = [
    receipt.sha256,
    receipt.artifact_sha256,
    source.sha256,
    source.source_sha256,
  ];
  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.network_access !== false
    || root.external_mutation !== false
    || verification.receipt_verified !== true
    || verification.source_exact_main !== true
    || verification.package_match !== true
    || hashes.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))
    || typeof source.commit_sha !== 'string'
    || !SHA1.test(source.commit_sha)
    || typeof source.tree_sha !== 'string'
    || !SHA1.test(source.tree_sha)
  ) {
    reject('binding: evidencia inválida.');
  }

  return Object.freeze({
    package: packageId(root.package, 'binding.package'),
    receiptSha: receipt.sha256 as string,
    artifactSha: receipt.artifact_sha256 as string,
    snapshotSha: source.sha256 as string,
    sourceSha: source.source_sha256 as string,
    commit: source.commit_sha,
    tree: source.tree_sha,
  });
}

function cli(argv: readonly string[]): Readonly<{
  receipt: string;
  snapshot: string;
  binding: string;
}> {
  if (argv.length !== 6) reject('Argumentos inválidos.');
  const pairs = new Map<string, string>();
  for (let index = 0; index < 6; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      value === undefined
      || value.trim() === ''
      || pairs.has(flag)
      || !['--verified-receipt', '--source-snapshot', '--binding'].includes(flag)
    ) {
      reject('Argumentos inválidos.');
    }
    pairs.set(flag, value);
  }
  const receipt = pairs.get('--verified-receipt');
  const snapshot = pairs.get('--source-snapshot');
  const binding = pairs.get('--binding');
  if (receipt === undefined || snapshot === undefined || binding === undefined) {
    reject('Faltan inputs requeridos.');
  }
  return Object.freeze({
    receipt: resolve(receipt),
    snapshot: resolve(snapshot),
    binding: resolve(binding),
  });
}

async function main(): Promise<void> {
  const options = cli(process.argv.slice(2));
  const [rawReceipt, rawSnapshot, rawBinding] = await Promise.all([
    readEvidence(options.receipt, MAX.receipt, 'verified receipt', false),
    readEvidence(options.snapshot, MAX.snapshot, 'source snapshot', true),
    readEvidence(options.binding, MAX.binding, 'binding', true),
  ]);

  const receipt = inspectReceipt(rawReceipt.value);
  const snapshot = inspectSnapshot(rawSnapshot.value);
  const binding = inspectBinding(rawBinding.value);

  if (
    !packageEqual(receipt.package, snapshot.package)
    || !packageEqual(receipt.package, binding.package)
    || binding.receiptSha !== receipt.receiptSha
    || binding.artifactSha !== receipt.artifactSha
    || binding.snapshotSha !== digest(rawSnapshot.bytes)
    || binding.sourceSha !== snapshot.sourceSha
    || binding.commit !== snapshot.commit
    || binding.tree !== snapshot.tree
  ) {
    reject('Release candidate: evidencia mixed, stale o tampered.');
  }

  const result = {
    accepted: true,
    package: receipt.package,
    repository: {
      commit_sha: snapshot.commit,
      tree_sha: snapshot.tree,
    },
    evidence: {
      artifact_sha256: receipt.artifactSha,
      receipt_sha256: receipt.receiptSha,
      source_snapshot_sha256: binding.snapshotSha,
      source_sha256: snapshot.sourceSha,
      binding_sha256: digest(rawBinding.bytes),
    },
    authority: 'unchanged',
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  };
  const output = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(output, 'utf8') > MAX.output) {
    reject('Release candidate: salida fuera de límites.');
  }
  process.stdout.write(output);
}

await main();
