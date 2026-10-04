import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type Inputs = Readonly<{
  handoff: string;
  receipt: string;
  snapshot: string;
  binding: string;
  preflight: string;
  mainPin: string;
}>;

type RepositoryIdentity = Readonly<{
  commit: string;
  tree: string;
}>;

const VERIFIER = fileURLToPath(
  new URL('./check-observability-release-handoff-packet.ts', import.meta.url),
);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UNKNOWN_SHA = /^0{40}$/;
const MAX_INPUT_BYTES = 4096;
const MAX_OUTPUT_BYTES = 4096;

function reject(message: string): never {
  throw new Error(message);
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
  const actual = Object.keys(record).sort((a, b) => a.localeCompare(b, 'en')).join('\u0000');
  const expected = [...expectedKeys].sort((a, b) => a.localeCompare(b, 'en')).join('\u0000');
  if (actual !== expected) reject(`${label}: schema no reconocido.`);
  return record;
}

function exactRepository(value: unknown, label: string): RepositoryIdentity {
  const repository = closedRecord(value, label, ['commit_sha', 'tree_sha']);
  if (
    typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || UNKNOWN_SHA.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || UNKNOWN_SHA.test(repository.tree_sha)
    || repository.commit_sha === repository.tree_sha
  ) {
    reject(`${label}: identidad inválida o UNKNOWN.`);
  }
  return Object.freeze({
    commit: repository.commit_sha,
    tree: repository.tree_sha,
  });
}

function parseInputs(argv: readonly string[]): Inputs {
  const expected = [
    '--handoff',
    '--verified-receipt',
    '--source-snapshot',
    '--binding',
    '--preflight',
    '--main-pin',
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
    mainPin: values[5],
  });
}

async function boundedFile(path: string, label: string): Promise<Buffer> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || info.size <= 0
    || info.size > MAX_INPUT_BYTES
  ) {
    reject(`${label}: archivo local inválido o fuera de límites.`);
  }
  return readFile(path);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    reject(`${label}: JSON inválido.`);
  }
}

async function verifyHandoff(inputs: Inputs): Promise<Readonly<{
  handoffSha256: string;
  repository: RepositoryIdentity;
}>> {
  const verifier = await lstat(VERIFIER);
  if (verifier.isSymbolicLink() || !verifier.isFile()) {
    reject('handoff replay guard: verifier canónico inválido.');
  }

  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      VERIFIER,
      '--handoff',
      inputs.handoff,
      '--verified-receipt',
      inputs.receipt,
      '--source-snapshot',
      inputs.snapshot,
      '--binding',
      inputs.binding,
      '--preflight',
      inputs.preflight,
    ],
    {
      encoding: 'utf8',
      env: {},
      timeout: 45_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (
    run.error !== undefined
    || run.status !== 0
    || run.signal !== null
    || typeof run.stdout !== 'string'
    || Buffer.byteLength(run.stdout, 'utf8') <= 0
    || Buffer.byteLength(run.stdout, 'utf8') > MAX_OUTPUT_BYTES
  ) {
    reject('handoff replay guard: handoff no verificable.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(run.stdout) as unknown;
  } catch {
    reject('handoff replay guard: salida del verifier inválida.');
  }
  const root = closedRecord(raw, 'verified_handoff', [
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
    || typeof root.handoff_sha256 !== 'string'
    || !SHA256.test(root.handoff_sha256)
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    reject('handoff replay guard: verifier rechazado.');
  }

  return Object.freeze({
    handoffSha256: root.handoff_sha256,
    repository: exactRepository(root.repository, 'verified_handoff.repository'),
  });
}

async function mainPin(path: string): Promise<RepositoryIdentity> {
  const root = closedRecord(
    parseJson(await boundedFile(path, 'main pin'), 'main pin'),
    'main_pin',
    [
      'schema_version',
      'repository',
      'verification',
      'authority',
      'publish_authority',
      'network_access',
      'external_mutation',
    ],
  );
  const repository = closedRecord(root.repository, 'main_pin.repository', [
    'ref',
    'commit_sha',
    'tree_sha',
  ]);
  const verification = closedRecord(root.verification, 'main_pin.verification', [
    'current_main_explicit',
  ]);
  if (
    root.schema_version !== 1
    || repository.ref !== 'refs/heads/main'
    || verification.current_main_explicit !== true
    || root.authority !== 'unchanged'
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    reject('main pin: contrato rechazado.');
  }
  return exactRepository(
    { commit_sha: repository.commit_sha, tree_sha: repository.tree_sha },
    'main_pin.repository',
  );
}

async function main(): Promise<void> {
  const inputs = parseInputs(process.argv.slice(2));
  const verified = await verifyHandoff(inputs);
  const currentMain = await mainPin(inputs.mainPin);

  if (
    verified.repository.commit !== currentMain.commit
    || verified.repository.tree !== currentMain.tree
  ) {
    reject('handoff replay guard: handoff stale frente a current-main pin.');
  }

  const result = JSON.stringify({
    verified: true,
    fresh: true,
    schema_version: 1,
    handoff_sha256: verified.handoffSha256,
    repository: {
      commit_sha: verified.repository.commit,
      tree_sha: verified.repository.tree,
    },
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  }) + '\n';
  if (Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES) {
    reject('handoff replay guard: salida fuera de límites.');
  }
  process.stdout.write(result);
}

await main();
