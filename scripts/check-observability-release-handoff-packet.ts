import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type Inputs = Readonly<{
  handoff: string;
  receipt: string;
  snapshot: string;
  binding: string;
  preflight: string;
}>;

const BUILDER = fileURLToPath(
  new URL('./create-observability-release-handoff-packet.ts', import.meta.url),
);
const MAX_PACKET_BYTES = 4096;
const TOP_LEVEL = [
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
] as const;

function reject(message: string): never {
  throw new Error(message);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function closedRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    reject(`${label}: objeto requerido.`);
  }
  const record = value as JsonObject;
  const actual = Object.keys(record).sort().join('\u0000');
  const expected = [...expectedKeys].sort().join('\u0000');
  if (actual !== expected) reject(`${label}: schema no reconocido.`);
  return record;
}

function inspectPacket(value: unknown): Readonly<{
  package: JsonObject;
  repository: JsonObject;
  evidence: JsonObject;
}> {
  const root = closedRecord(value, 'handoff', TOP_LEVEL);
  const pkg = closedRecord(root.package, 'handoff.package', [
    'name',
    'version',
    'private',
    'type',
  ]);
  const repository = closedRecord(root.repository, 'handoff.repository', [
    'commit_sha',
    'tree_sha',
  ]);
  const evidence = closedRecord(root.evidence, 'handoff.evidence', [
    'artifact_sha256',
    'receipt_sha256',
    'source_snapshot_sha256',
    'source_sha256',
    'binding_sha256',
    'preflight_sha256',
  ]);
  const verification = closedRecord(root.verification, 'handoff.verification', [
    'exact_main',
    'release_candidate_accepted',
  ]);

  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
    || verification.exact_main !== true
    || verification.release_candidate_accepted !== true
    || pkg.private !== true
    || pkg.type !== 'module'
  ) {
    reject('handoff: packet rechazado.');
  }

  return Object.freeze({
    package: Object.freeze({ ...pkg }),
    repository: Object.freeze({ ...repository }),
    evidence: Object.freeze({ ...evidence }),
  });
}

function parseInputs(argv: readonly string[]): Inputs {
  const expected = [
    '--handoff',
    '--verified-receipt',
    '--source-snapshot',
    '--binding',
    '--preflight',
  ] as const;
  if (argv.length !== expected.length * 2) reject('Argumentos inválidos.');

  const values: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const flag = argv[index * 2];
    const value = argv[index * 2 + 1];
    if (flag !== expected[index] || value === undefined || value.trim() === '') {
      reject('Argumentos inválidos.');
    }
    values.push(resolve(value));
  }

  return Object.freeze({
    handoff: values[0],
    receipt: values[1],
    snapshot: values[2],
    binding: values[3],
    preflight: values[4],
  });
}

async function boundedPacket(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || info.size <= 0
    || info.size > MAX_PACKET_BYTES
  ) {
    reject('handoff: archivo local inválido o fuera de límites.');
  }
  return readFile(path);
}

async function regenerate(inputs: Inputs): Promise<Buffer> {
  const builder = await lstat(BUILDER);
  if (builder.isSymbolicLink() || !builder.isFile()) {
    reject('handoff: builder canónico inválido.');
  }

  const workspace = await mkdtemp(join(tmpdir(), 'factoryrunner-handoff-verify-'));
  const output = join(workspace, 'expected.json');
  try {
    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        BUILDER,
        '--verified-receipt',
        inputs.receipt,
        '--source-snapshot',
        inputs.snapshot,
        '--binding',
        inputs.binding,
        '--preflight',
        inputs.preflight,
        '--output',
        output,
      ],
      {
        encoding: 'utf8',
        env: {},
        timeout: 45_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    );
    if (run.error !== undefined || run.status !== 0 || run.signal !== null) {
      reject('handoff: no fue posible regenerar el packet canónico.');
    }
    return await boundedPacket(output);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const inputs = parseInputs(process.argv.slice(2));
  const supplied = await boundedPacket(inputs.handoff);
  const expected = await regenerate(inputs);
  if (!supplied.equals(expected)) {
    reject('handoff: packet tampered, mixed, stale o sustituido.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(supplied.toString('utf8')) as unknown;
  } catch {
    reject('handoff: JSON inválido.');
  }
  const packet = inspectPacket(raw);
  const result = JSON.stringify({
    verified: true,
    schema_version: 1,
    handoff_sha256: sha256(supplied),
    package: packet.package,
    repository: packet.repository,
    evidence: packet.evidence,
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  }) + '\n';
  if (Buffer.byteLength(result, 'utf8') > MAX_PACKET_BYTES) {
    reject('handoff: salida fuera de límites.');
  }
  process.stdout.write(result);
}

await main();
