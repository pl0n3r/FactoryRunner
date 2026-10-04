import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type PackageIdentity = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type Preflight = Readonly<{
  package: PackageIdentity;
  commit: string;
  tree: string;
  artifactSha: string;
  receiptSha: string;
  snapshotSha: string;
  sourceSha: string;
  bindingSha: string;
}>;

const PREFLIGHT = fileURLToPath(
  new URL('./check-observability-release-candidate-preflight.ts', import.meta.url),
);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_PREFLIGHT = 4096;
const MAX_OUTPUT = 4096;

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
  return value;
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

function packageIdentity(value: unknown): PackageIdentity {
  const item = exactObject(value, 'preflight.package', ['name', 'version', 'private', 'type']);
  if (
    typeof item.name !== 'string'
    || !item.name.startsWith('@pl0n3r/')
    || !PACKAGE.test(item.name)
    || typeof item.version !== 'string'
    || !VERSION.test(item.version)
    || item.private !== true
    || item.type !== 'module'
  ) {
    fail('preflight.package: identidad inválida.');
  }
  return Object.freeze({
    name: item.name,
    version: item.version,
    private: true,
    type: 'module',
  });
}

function inspectPreflight(value: unknown): Preflight {
  const root = exactObject(value, 'preflight', [
    'accepted',
    'package',
    'repository',
    'evidence',
    'authority',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  const repository = exactObject(root.repository, 'preflight.repository', [
    'commit_sha',
    'tree_sha',
  ]);
  const evidence = exactObject(root.evidence, 'preflight.evidence', [
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
    fail('preflight: release candidate rechazado.');
  }
  return Object.freeze({
    package: packageIdentity(root.package),
    commit: repository.commit_sha,
    tree: repository.tree_sha,
    artifactSha: evidence.artifact_sha256 as string,
    receiptSha: evidence.receipt_sha256 as string,
    snapshotSha: evidence.source_snapshot_sha256 as string,
    sourceSha: evidence.source_sha256 as string,
    bindingSha: evidence.binding_sha256 as string,
  });
}

function options(argv: readonly string[]): Readonly<{
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
    const value = argv[cursor + 1];
    if (
      !accepted.has(flag)
      || value === undefined
      || value.trim() === ''
      || parsed.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(flag, resolve(value));
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
  return Object.freeze({ receipt, snapshot, binding, preflight, output });
}

async function preflightBytes(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > MAX_PREFLIGHT
  ) {
    fail('preflight: archivo local inválido o fuera de límites.');
  }
  return readFile(path);
}

function verifyReleaseCandidate(
  receipt: string,
  snapshot: string,
  binding: string,
  provided: Buffer,
): Preflight {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      PREFLIGHT,
      '--verified-receipt',
      receipt,
      '--source-snapshot',
      snapshot,
      '--binding',
      binding,
    ],
    {
      encoding: 'utf8',
      env: {},
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    fail('Release handoff: preflight exact-main no verificable.');
  }
  const stdout = result.stdout ?? '';
  if (
    Buffer.byteLength(stdout, 'utf8') > MAX_PREFLIGHT
    || stdout !== provided.toString('utf8')
  ) {
    fail('Release handoff: preflight mixed, stale o tampered.');
  }
  return inspectPreflight(parseJson(provided, 'preflight'));
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const suppliedPreflight = await preflightBytes(parsed.preflight);
  const verified = verifyReleaseCandidate(
    parsed.receipt,
    parsed.snapshot,
    parsed.binding,
    suppliedPreflight,
  );

  const packet = {
    schema_version: 1,
    package: verified.package,
    repository: {
      commit_sha: verified.commit,
      tree_sha: verified.tree,
    },
    evidence: {
      artifact_sha256: verified.artifactSha,
      receipt_sha256: verified.receiptSha,
      source_snapshot_sha256: verified.snapshotSha,
      source_sha256: verified.sourceSha,
      binding_sha256: verified.bindingSha,
      preflight_sha256: sha256(suppliedPreflight),
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
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT) {
    fail('Release handoff: salida fuera de límites.');
  }
  await writeFile(parsed.output, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

await main();
