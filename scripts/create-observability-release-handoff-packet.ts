import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type PackageIdentity = Readonly<{
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
const LIMITS = Object.freeze({
  receipt: 4096,
  snapshot: 64 * 1024,
  binding: 4096,
  preflight: 4096,
  output: 4096,
});

function fail(message: string): never {
  throw new Error(message);
}

function sha256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function exactObject(value: unknown, label: string, fields: readonly string[]): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label}: objeto requerido.`);
  }
  const object = value as JsonObject;
  const allowed = new Set(fields);
  const keys = Object.keys(object);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail(`${label}: schema no reconocido.`);
  }
  return object;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Valor no serializable.');
    return value;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
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
    fail(`${label}: JSON inválido.`);
  }
}

function parseCanonicalJson(body: Buffer, label: string): unknown {
  const parsed = parseJson(body, label);
  if (body.toString('utf8') !== canonicalJson(parsed)) {
    fail(`${label}: representación JSON no canónica.`);
  }
  return parsed;
}

async function readEvidence(
  path: string,
  maximum: number,
  label: string,
  canonical: boolean,
): Promise<Evidence<unknown>> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > maximum
  ) {
    fail(`${label}: archivo local inválido o fuera de límites.`);
  }
  const bytes = await readFile(path);
  const value = canonical ? parseCanonicalJson(bytes, label) : parseJson(bytes, label);
  return Object.freeze({ bytes, value });
}

function packageIdentity(value: unknown, label: string): PackageIdentity {
  const item = exactObject(value, label, ['name', 'version', 'private', 'type']);
  if (
    typeof item.name !== 'string'
    || !item.name.startsWith('@pl0n3r/')
    || !PACKAGE.test(item.name)
    || typeof item.version !== 'string'
    || !VERSION.test(item.version)
    || item.private !== true
    || item.type !== 'module'
  ) {
    fail(`${label}: identidad inválida.`);
  }
  return Object.freeze({
    name: item.name,
    version: item.version,
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

function inspectReceipt(value: unknown): Readonly<{
  package: PackageIdentity;
  receiptSha: string;
  artifactSha: string;
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
    || !SHA256.test(root.receipt_sha256)
    || typeof root.artifact_sha256 !== 'string'
    || !SHA256.test(root.artifact_sha256)
  ) {
    fail('verified receipt: evidencia rechazada.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'verified receipt.package'),
    receiptSha: root.receipt_sha256,
    artifactSha: root.artifact_sha256,
  });
}

function inspectSnapshot(value: unknown): Readonly<{
  package: PackageIdentity;
  commit: string;
  tree: string;
  sourceSha: string;
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
  const repository = exactObject(
    root.repository,
    'source snapshot.repository',
    ['ref', 'commit_sha', 'tree_sha'],
  );
  const source = exactObject(root.source, 'source snapshot.source', ['sha256', 'files']);
  const verification = exactObject(
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
    || sha256(canonicalJson(source.files)) !== source.sha256
  ) {
    fail('source snapshot: evidencia exact-main inválida.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'source snapshot.package'),
    commit: repository.commit_sha,
    tree: repository.tree_sha,
    sourceSha: source.sha256,
  });
}

function inspectBinding(value: unknown): Readonly<{
  package: PackageIdentity;
  receiptSha: string;
  artifactSha: string;
  snapshotSha: string;
  sourceSha: string;
  commit: string;
  tree: string;
}> {
  const root = exactObject(value, 'binding', [
    'schema_version',
    'package',
    'receipt',
    'source_snapshot',
    'verification',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  const receipt = exactObject(root.receipt, 'binding.receipt', ['sha256', 'artifact_sha256']);
  const source = exactObject(root.source_snapshot, 'binding.source_snapshot', [
    'sha256',
    'source_sha256',
    'commit_sha',
    'tree_sha',
  ]);
  const verification = exactObject(root.verification, 'binding.verification', [
    'receipt_verified',
    'source_exact_main',
    'package_match',
  ]);
  const hashes = [receipt.sha256, receipt.artifact_sha256, source.sha256, source.source_sha256];
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
    fail('binding: evidencia inválida.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'binding.package'),
    receiptSha: receipt.sha256 as string,
    artifactSha: receipt.artifact_sha256 as string,
    snapshotSha: source.sha256 as string,
    sourceSha: source.source_sha256 as string,
    commit: source.commit_sha,
    tree: source.tree_sha,
  });
}

function inspectPreflight(value: unknown): Readonly<{
  package: PackageIdentity;
  commit: string;
  tree: string;
  artifactSha: string;
  receiptSha: string;
  snapshotSha: string;
  sourceSha: string;
  bindingSha: string;
}> {
  const root = exactObject(value, 'release candidate preflight', [
    'accepted',
    'package',
    'repository',
    'evidence',
    'authority',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  const repository = exactObject(
    root.repository,
    'release candidate preflight.repository',
    ['commit_sha', 'tree_sha'],
  );
  const evidence = exactObject(root.evidence, 'release candidate preflight.evidence', [
    'artifact_sha256',
    'receipt_sha256',
    'source_snapshot_sha256',
    'source_sha256',
    'binding_sha256',
  ]);
  const hashes = [
    evidence.artifact_sha256,
    evidence.receipt_sha256,
    evidence.source_snapshot_sha256,
    evidence.source_sha256,
    evidence.binding_sha256,
  ];
  if (
    root.accepted !== true
    || root.authority !== 'unchanged'
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
    || typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || hashes.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))
  ) {
    fail('release candidate preflight: evidencia rechazada.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'release candidate preflight.package'),
    commit: repository.commit_sha,
    tree: repository.tree_sha,
    artifactSha: evidence.artifact_sha256 as string,
    receiptSha: evidence.receipt_sha256 as string,
    snapshotSha: evidence.source_snapshot_sha256 as string,
    sourceSha: evidence.source_sha256 as string,
    bindingSha: evidence.binding_sha256 as string,
  });
}

function parseOptions(argv: readonly string[]): Readonly<{
  receipt: string;
  snapshot: string;
  binding: string;
  preflight: string;
  output: string;
}> {
  if (argv.length !== 10) fail('Argumentos inválidos.');
  const accepted = new Set([
    '--verified-receipt',
    '--source-snapshot',
    '--binding',
    '--preflight',
    '--output',
  ]);
  const parsed = new Map<string, string>();
  for (let cursor = 0; cursor < argv.length; cursor += 2) {
    const flag = argv[cursor];
    const candidate = argv[cursor + 1];
    if (
      !accepted.has(flag)
      || candidate === undefined
      || candidate.trim() === ''
      || parsed.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(flag, candidate);
  }
  const receipt = parsed.get('--verified-receipt');
  const snapshot = parsed.get('--source-snapshot');
  const binding = parsed.get('--binding');
  const preflight = parsed.get('--preflight');
  const output = parsed.get('--output');
  if (
    receipt === undefined
    || snapshot === undefined
    || binding === undefined
    || preflight === undefined
    || output === undefined
  ) {
    fail('Faltan inputs requeridos.');
  }
  return Object.freeze({
    receipt: resolve(receipt),
    snapshot: resolve(snapshot),
    binding: resolve(binding),
    preflight: resolve(preflight),
    output: resolve(output),
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [rawReceipt, rawSnapshot, rawBinding, rawPreflight] = await Promise.all([
    readEvidence(options.receipt, LIMITS.receipt, 'verified receipt', false),
    readEvidence(options.snapshot, LIMITS.snapshot, 'source snapshot', true),
    readEvidence(options.binding, LIMITS.binding, 'binding', true),
    readEvidence(options.preflight, LIMITS.preflight, 'release candidate preflight', false),
  ]);

  const receipt = inspectReceipt(rawReceipt.value);
  const snapshot = inspectSnapshot(rawSnapshot.value);
  const binding = inspectBinding(rawBinding.value);
  const preflight = inspectPreflight(rawPreflight.value);

  if (
    !samePackage(receipt.package, snapshot.package)
    || !samePackage(receipt.package, binding.package)
    || !samePackage(receipt.package, preflight.package)
    || binding.receiptSha !== receipt.receiptSha
    || binding.artifactSha !== receipt.artifactSha
    || binding.snapshotSha !== sha256(rawSnapshot.bytes)
    || binding.sourceSha !== snapshot.sourceSha
    || binding.commit !== snapshot.commit
    || binding.tree !== snapshot.tree
    || preflight.artifactSha !== receipt.artifactSha
    || preflight.receiptSha !== receipt.receiptSha
    || preflight.snapshotSha !== binding.snapshotSha
    || preflight.sourceSha !== snapshot.sourceSha
    || preflight.bindingSha !== sha256(rawBinding.bytes)
    || preflight.commit !== snapshot.commit
    || preflight.tree !== snapshot.tree
  ) {
    fail('Release handoff: evidencia mixed, stale o tampered.');
  }

  const packet = {
    schema_version: 1,
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
      binding_sha256: preflight.bindingSha,
      preflight_sha256: sha256(rawPreflight.bytes),
    },
    verification: {
      exact_main: true,
      release_candidate_accepted: true,
    },
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  };

  const serialized = canonicalJson(packet);
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.output) {
    fail('Release handoff: salida fuera de límites.');
  }
  await writeFile(options.output, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

await main();
