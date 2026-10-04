import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type PackageIdentity = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

const BUILDER = fileURLToPath(
  new URL('./create-observability-release-handoff-packet.ts', import.meta.url),
);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const LIMITS = Object.freeze({
  handoff: 4096,
  output: 4096,
});

function fail(message: string): never {
  throw new Error(message);
}

function digest(body: Uint8Array): string {
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

function packageIdentity(value: unknown): PackageIdentity {
  const item = exactObject(value, 'handoff.package', ['name', 'version', 'private', 'type']);
  if (
    typeof item.name !== 'string'
    || !item.name.startsWith('@pl0n3r/')
    || !PACKAGE.test(item.name)
    || typeof item.version !== 'string'
    || !VERSION.test(item.version)
    || item.private !== true
    || item.type !== 'module'
  ) {
    fail('handoff.package: identidad inválida.');
  }
  return Object.freeze({
    name: item.name,
    version: item.version,
    private: true,
    type: 'module',
  });
}

function inspectPacket(value: unknown): Readonly<{
  package: PackageIdentity;
  repository: Readonly<{ commit_sha: string; tree_sha: string }>;
  evidence: Readonly<Record<string, string>>;
}> {
  const root = exactObject(value, 'handoff', [
    'schema_version',
    'package',
    'repository',
    'evidence',
    'verification',
    'authority',
    'decision_required',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  const repository = exactObject(root.repository, 'handoff.repository', [
    'commit_sha',
    'tree_sha',
  ]);
  const evidence = exactObject(root.evidence, 'handoff.evidence', [
    'artifact_sha256',
    'receipt_sha256',
    'source_snapshot_sha256',
    'source_sha256',
    'binding_sha256',
    'preflight_sha256',
  ]);
  const verification = exactObject(root.verification, 'handoff.verification', [
    'exact_main',
    'release_candidate_accepted',
  ]);
  const hashes = Object.values(evidence);
  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
    || verification.exact_main !== true
    || verification.release_candidate_accepted !== true
    || typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || hashes.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))
  ) {
    fail('handoff: packet rechazado.');
  }
  return Object.freeze({
    package: packageIdentity(root.package),
    repository: Object.freeze({
      commit_sha: repository.commit_sha,
      tree_sha: repository.tree_sha,
    }),
    evidence: Object.freeze(Object.fromEntries(
      Object.entries(evidence).map(([key, entry]) => [key, entry as string]),
    )),
  });
}

function options(argv: readonly string[]): Readonly<{
  handoff: string;
  receipt: string;
  snapshot: string;
  binding: string;
  preflight: string;
}> {
  const flags = [
    '--handoff',
    '--verified-receipt',
    '--source-snapshot',
    '--binding',
    '--preflight',
  ] as const;
  if (argv.length !== flags.length * 2) fail('Argumentos inválidos.');
  const parsed = new Map<string, string>();
  for (let cursor = 0; cursor < argv.length; cursor += 2) {
    const flag = argv[cursor];
    const value = argv[cursor + 1];
    if (
      !flags.includes(flag as typeof flags[number])
      || value === undefined
      || value.trim() === ''
      || parsed.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(flag, resolve(value));
  }
  if (flags.some((flag) => !parsed.has(flag))) fail('Faltan inputs requeridos.');
  return Object.freeze({
    handoff: parsed.get('--handoff') as string,
    receipt: parsed.get('--verified-receipt') as string,
    snapshot: parsed.get('--source-snapshot') as string,
    binding: parsed.get('--binding') as string,
    preflight: parsed.get('--preflight') as string,
  });
}

async function handoffBytes(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > LIMITS.handoff
  ) {
    fail('handoff: archivo local inválido o fuera de límites.');
  }
  return readFile(path);
}

async function regenerateExpected(
  receipt: string,
  snapshot: string,
  binding: string,
  preflight: string,
): Promise<Buffer> {
  const builderMetadata = await lstat(BUILDER);
  if (builderMetadata.isSymbolicLink() || !builderMetadata.isFile()) {
    fail('handoff: builder canónico inválido.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'factoryrunner-handoff-verify-'));
  const output = join(directory, 'expected.json');
  try {
    const completed = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        BUILDER,
        '--verified-receipt',
        receipt,
        '--source-snapshot',
        snapshot,
        '--binding',
        binding,
        '--preflight',
        preflight,
        '--output',
        output,
      ],
      {
        encoding: 'utf8',
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 45_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    );
    if (
      completed.error !== undefined
      || completed.status !== 0
      || completed.signal !== null
    ) {
      fail('handoff: no fue posible regenerar el packet canónico.');
    }
    return await handoffBytes(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const supplied = await handoffBytes(parsed.handoff);
  const expected = await regenerateExpected(
    parsed.receipt,
    parsed.snapshot,
    parsed.binding,
    parsed.preflight,
  );
  if (!supplied.equals(expected)) {
    fail('handoff: packet tampered, mixed, stale o sustituido.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(supplied.toString('utf8')) as unknown;
  } catch {
    fail('handoff: JSON inválido.');
  }
  const packet = inspectPacket(raw);
  const output = JSON.stringify({
    verified: true,
    schema_version: 1,
    handoff_sha256: digest(supplied),
    package: packet.package,
    repository: packet.repository,
    evidence: packet.evidence,
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  }) + '\n';
  if (Buffer.byteLength(output, 'utf8') > LIMITS.output) {
    fail('handoff: salida fuera de límites.');
  }
  process.stdout.write(output);
}

await main();
