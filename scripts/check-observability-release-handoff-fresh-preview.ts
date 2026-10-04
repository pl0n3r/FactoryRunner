import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

const GUARD = fileURLToPath(
  new URL('./check-observability-release-handoff-replay-guard.ts', import.meta.url),
);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UNKNOWN_SHA = /^0{40}$/;
const MAX_GUARD_BYTES = 4096;
const MAX_OUTPUT_BYTES = 2048;

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

function parseArgs(argv: readonly string[]): readonly string[] {
  const expected = [
    '--handoff',
    '--verified-receipt',
    '--source-snapshot',
    '--binding',
    '--preflight',
    '--main-pin',
  ] as const;
  if (argv.length !== expected.length * 2) reject('fresh preview: argumentos inválidos.');
  for (let index = 0; index < expected.length; index += 1) {
    if (
      argv[index * 2] !== expected[index]
      || argv[index * 2 + 1] === undefined
      || argv[index * 2 + 1]?.trim() === ''
    ) {
      reject('fresh preview: argumentos inválidos.');
    }
  }
  return argv;
}

async function verifiedFreshHandoff(argv: readonly string[]): Promise<JsonObject> {
  const guard = await lstat(GUARD);
  if (guard.isSymbolicLink() || !guard.isFile()) {
    reject('fresh preview: replay guard canónico inválido.');
  }

  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', GUARD, ...parseArgs(argv)],
    {
      encoding: 'utf8',
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45_000,
      maxBuffer: MAX_GUARD_BYTES,
      windowsHide: true,
    },
  );
  if (
    run.error !== undefined
    || run.status !== 0
    || run.signal !== null
    || typeof run.stdout !== 'string'
    || Buffer.byteLength(run.stdout, 'utf8') <= 0
    || Buffer.byteLength(run.stdout, 'utf8') > MAX_GUARD_BYTES
  ) {
    reject('fresh preview: handoff no vigente o no verificable.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(run.stdout) as unknown;
  } catch {
    reject('fresh preview: replay guard produjo JSON inválido.');
  }

  const root = closedRecord(raw, 'fresh_handoff', [
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
  const repository = closedRecord(
    root.repository,
    'fresh_handoff.repository',
    ['commit_sha', 'tree_sha'],
  );

  if (
    root.verified !== true
    || root.fresh !== true
    || root.schema_version !== 1
    || typeof root.handoff_sha256 !== 'string'
    || !SHA256.test(root.handoff_sha256)
    || typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || UNKNOWN_SHA.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || UNKNOWN_SHA.test(repository.tree_sha)
    || repository.commit_sha === repository.tree_sha
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    reject('fresh preview: contrato vigente rechazado.');
  }

  return {
    verified: true,
    fresh: true,
    schema_version: 1,
    handoff_sha256: root.handoff_sha256,
    repository: {
      commit_sha: repository.commit_sha,
      tree_sha: repository.tree_sha,
    },
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  };
}

const output = JSON.stringify(await verifiedFreshHandoff(process.argv.slice(2))) + '\n';
if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
  reject('fresh preview: salida fuera de límites.');
}
process.stdout.write(output);
