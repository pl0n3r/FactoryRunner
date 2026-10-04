import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

const GUARD = fileURLToPath(
  new URL('./check-observability-release-handoff-replay-guard.ts', import.meta.url),
);
const MAX_BYTES = 4096;
const FLAGS = [
  '--handoff',
  '--verified-receipt',
  '--source-snapshot',
  '--binding',
  '--preflight',
  '--main-pin',
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail('fresh preview: objeto inválido.');
  }
  return value as JsonObject;
}

function checkedArgs(argv: readonly string[]): readonly string[] {
  if (argv.length !== FLAGS.length * 2) fail('fresh preview: argumentos inválidos.');
  FLAGS.forEach((flag, index) => {
    const value = argv[(index * 2) + 1];
    if (argv[index * 2] !== flag || typeof value !== 'string' || value.trim() === '') {
      fail('fresh preview: argumentos inválidos.');
    }
  });
  return argv;
}

async function guardOutput(argv: readonly string[]): Promise<JsonObject> {
  const info = await lstat(GUARD);
  if (info.isSymbolicLink() || !info.isFile()) fail('fresh preview: guard inválido.');

  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', GUARD, ...checkedArgs(argv)],
    {
      encoding: 'utf8',
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45_000,
      maxBuffer: MAX_BYTES,
      windowsHide: true,
    },
  );
  if (
    run.error !== undefined
    || run.status !== 0
    || run.signal !== null
    || typeof run.stdout !== 'string'
    || run.stdout.length === 0
    || Buffer.byteLength(run.stdout, 'utf8') > MAX_BYTES
  ) {
    fail('fresh preview: handoff no vigente o no verificable.');
  }

  try {
    return record(JSON.parse(run.stdout) as unknown);
  } catch {
    fail('fresh preview: salida inválida.');
  }
}

const guarded = await guardOutput(process.argv.slice(2));
const repository = record(guarded.repository);
const sha1 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;

if (
  guarded.verified !== true
  || guarded.fresh !== true
  || guarded.schema_version !== 1
  || typeof guarded.handoff_sha256 !== 'string'
  || !sha256.test(guarded.handoff_sha256)
  || typeof repository.commit_sha !== 'string'
  || typeof repository.tree_sha !== 'string'
  || !sha1.test(repository.commit_sha)
  || !sha1.test(repository.tree_sha)
  || /^0{40}$/.test(repository.commit_sha)
  || /^0{40}$/.test(repository.tree_sha)
  || repository.commit_sha === repository.tree_sha
  || guarded.authority !== 'unchanged'
  || guarded.decision_required !== true
  || guarded.publish_authority !== false
  || guarded.network_access !== false
  || guarded.external_mutation !== false
) {
  fail('fresh preview: contrato vigente rechazado.');
}

const output = JSON.stringify({
  verified: true,
  fresh: true,
  schema_version: 1,
  handoff_sha256: guarded.handoff_sha256,
  repository: {
    commit_sha: repository.commit_sha,
    tree_sha: repository.tree_sha,
  },
  authority: 'unchanged',
  decision_required: true,
  publish_authority: false,
  network_access: false,
  external_mutation: false,
}) + '\n';

if (Buffer.byteLength(output, 'utf8') > 2048) fail('fresh preview: salida fuera de límites.');
process.stdout.write(output);
