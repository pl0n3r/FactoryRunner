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

type RepositoryIdentity = Readonly<{
  commitSha: string;
  treeSha: string;
}>;

type Options = Readonly<{
  verifiedReceipt: string;
  verifiedHandoff: string;
  freshPreview: string;
  output: string;
}>;

const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({
  verifiedReceipt: 4096,
  verifiedHandoff: 4096,
  freshPreview: 2048,
  output: 4096,
});

function fail(message: string): never {
  throw new Error(message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactObject(
  value: unknown,
  label: string,
  fields: readonly string[],
): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(label + ': objeto requerido.');
  }
  const record = value as JsonObject;
  const allowed = new Set(fields);
  const present = Object.keys(record);
  if (
    present.length !== allowed.size
    || present.some((key) => !allowed.has(key))
  ) {
    fail(label + ': schema desconocido o incompleto.');
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

function validSha1(value: unknown): value is string {
  return typeof value === 'string'
    && SHA1_RE.test(value)
    && !/^0{40}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string'
    && SHA256_RE.test(value)
    && !/^0{64}$/.test(value);
}

function packageIdentity(value: unknown, label: string): PackageIdentity {
  const object = exactObject(value, label, [
    'name',
    'version',
    'private',
    'type',
  ]);
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

function repositoryIdentity(
  value: unknown,
  label: string,
): RepositoryIdentity {
  const object = exactObject(value, label, ['commit_sha', 'tree_sha']);
  if (
    !validSha1(object.commit_sha)
    || !validSha1(object.tree_sha)
    || object.commit_sha === object.tree_sha
  ) {
    fail(label + ': identidad inválida.');
  }
  return Object.freeze({
    commitSha: object.commit_sha,
    treeSha: object.tree_sha,
  });
}

function samePackage(left: PackageIdentity, right: PackageIdentity): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

function sameRepository(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return left.commitSha === right.commitSha
    && left.treeSha === right.treeSha;
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 8) fail('Argumentos inválidos.');
  const accepted = new Set([
    '--verified-receipt',
    '--verified-handoff',
    '--fresh-preview',
    '--output',
  ]);
  const parsed: Record<string, string> = {};

  for (let cursor = 0; cursor < argv.length; cursor += 2) {
    const flag = argv[cursor];
    const candidate = argv[cursor + 1];
    if (
      !accepted.has(flag)
      || candidate === undefined
      || candidate.trim() === ''
      || Object.hasOwn(parsed, flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed[flag] = candidate;
  }

  const verifiedReceipt = parsed['--verified-receipt'];
  const verifiedHandoff = parsed['--verified-handoff'];
  const freshPreview = parsed['--fresh-preview'];
  const output = parsed['--output'];
  if (
    verifiedReceipt === undefined
    || verifiedHandoff === undefined
    || freshPreview === undefined
    || output === undefined
  ) {
    fail('Falta input requerido.');
  }

  return Object.freeze({
    verifiedReceipt: resolve(verifiedReceipt),
    verifiedHandoff: resolve(verifiedHandoff),
    freshPreview: resolve(freshPreview),
    output: resolve(output),
  });
}

async function localJson(
  path: string,
  maximum: number,
  label: string,
): Promise<unknown> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > maximum
  ) {
    fail(label + ': archivo local inválido.');
  }
  try {
    return JSON.parse((await readFile(path)).toString('utf8')) as unknown;
  } catch {
    fail(label + ': JSON inválido.');
  }
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
    || !validSha256(root.receipt_sha256)
    || !validSha256(root.artifact_sha256)
  ) {
    fail('verified receipt: evidencia inválida.');
  }
  return Object.freeze({
    package: packageIdentity(root.package, 'verified receipt.package'),
    receiptSha256: root.receipt_sha256,
    artifactSha256: root.artifact_sha256,
  });
}

function verifiedHandoff(value: unknown): Readonly<{
  package: PackageIdentity;
  repository: RepositoryIdentity;
  handoffSha256: string;
  receiptSha256: string;
  artifactSha256: string;
}> {
  const root = exactObject(value, 'verified handoff', [
    'verified',
    'schema_version',
    'handoff_sha256',
    'package',
    'repository',
    'evidence',
    'authority',
    'decision_required',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.verified !== true
    || root.schema_version !== 1
    || !validSha256(root.handoff_sha256)
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('verified handoff: evidencia inválida.');
  }

  const evidence = exactObject(root.evidence, 'verified handoff.evidence', [
    'artifact_sha256',
    'receipt_sha256',
    'source_snapshot_sha256',
    'source_sha256',
    'binding_sha256',
    'preflight_sha256',
  ]);
  for (const field of [
    'artifact_sha256',
    'receipt_sha256',
    'source_snapshot_sha256',
    'source_sha256',
    'binding_sha256',
    'preflight_sha256',
  ]) {
    if (!validSha256(evidence[field])) {
      fail('verified handoff.evidence: hash inválido.');
    }
  }

  return Object.freeze({
    package: packageIdentity(root.package, 'verified handoff.package'),
    repository: repositoryIdentity(
      root.repository,
      'verified handoff.repository',
    ),
    handoffSha256: root.handoff_sha256,
    receiptSha256: evidence.receipt_sha256 as string,
    artifactSha256: evidence.artifact_sha256 as string,
  });
}

function freshPreview(value: unknown): Readonly<{
  repository: RepositoryIdentity;
  handoffSha256: string;
}> {
  const root = exactObject(value, 'fresh preview', [
    'verified',
    'fresh',
    'schema_version',
    'handoff_sha256',
    'repository',
    'authority',
    'decision_required',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.verified !== true
    || root.fresh !== true
    || root.schema_version !== 1
    || !validSha256(root.handoff_sha256)
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('fresh preview: evidencia inválida.');
  }
  return Object.freeze({
    repository: repositoryIdentity(root.repository, 'fresh preview.repository'),
    handoffSha256: root.handoff_sha256,
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [receiptRaw, handoffRaw, freshRaw] = await Promise.all([
    localJson(
      options.verifiedReceipt,
      LIMITS.verifiedReceipt,
      'verified receipt',
    ),
    localJson(
      options.verifiedHandoff,
      LIMITS.verifiedHandoff,
      'verified handoff',
    ),
    localJson(options.freshPreview, LIMITS.freshPreview, 'fresh preview'),
  ]);

  const receipt = verifiedReceipt(receiptRaw);
  const handoff = verifiedHandoff(handoffRaw);
  const fresh = freshPreview(freshRaw);

  if (!samePackage(receipt.package, handoff.package)) {
    fail('Binding rechazado: package identity divergente.');
  }
  if (
    receipt.artifactSha256 !== handoff.artifactSha256
    || receipt.receiptSha256 !== handoff.receiptSha256
  ) {
    fail('Binding rechazado: artifact/receipt divergente.');
  }
  if (handoff.handoffSha256 !== fresh.handoffSha256) {
    fail('Binding rechazado: handoff divergente o stale.');
  }
  if (!sameRepository(handoff.repository, fresh.repository)) {
    fail('Binding rechazado: current-main divergente o stale.');
  }

  const binding = {
    schema_version: 1,
    package: receipt.package,
    evidence: {
      artifact_sha256: receipt.artifactSha256,
      receipt_sha256: receipt.receiptSha256,
      handoff_sha256: handoff.handoffSha256,
    },
    repository: {
      commit_sha: handoff.repository.commitSha,
      tree_sha: handoff.repository.treeSha,
    },
    verification: {
      receipt_verified: true,
      handoff_verified: true,
      handoff_fresh: true,
      package_match: true,
      artifact_match: true,
      receipt_match: true,
      handoff_match: true,
      repository_match: true,
    },
    authority: 'unchanged',
    publish_authority: false,
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
