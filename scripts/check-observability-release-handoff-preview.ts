import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

const VERIFIER = fileURLToPath(
  new URL('./check-observability-release-handoff-packet.ts', import.meta.url),
);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_VERIFIER_BYTES = 4096;
const MAX_OUTPUT_BYTES = 2048;

function reject(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    reject(`${label}: objeto requerido.`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    reject(`${label}: texto inválido.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) reject(`${label}: fingerprint inválido.`);
  return result;
}

function parseVerified(stdout: string): JsonObject {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_VERIFIER_BYTES) {
    reject('preview: salida del verifier fuera de límites.');
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    reject('preview: verifier produjo JSON inválido.');
  }
  const root = record(value, 'verified_handoff');
  if (
    root.verified !== true
    || root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.decision_required !== true
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    reject('preview: handoff no verificado o autoridad inválida.');
  }
  return root;
}

function runVerifier(argv: readonly string[]): JsonObject {
  if (argv.length !== 10) reject('preview: argumentos inválidos.');
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', VERIFIER, ...argv],
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
    run.error !== undefined
    || run.status !== 0
    || run.signal !== null
    || run.stdout.length === 0
  ) {
    reject('preview: el handoff no pasó el verifier offline.');
  }
  return parseVerified(run.stdout);
}

function project(verified: JsonObject): JsonObject {
  const pkg = record(verified.package, 'verified_handoff.package');
  const repository = record(verified.repository, 'verified_handoff.repository');
  const evidence = record(verified.evidence, 'verified_handoff.evidence');

  const name = text(pkg.name, 'package.name', 128);
  const version = text(pkg.version, 'package.version', 64);
  const commitSha = text(repository.commit_sha, 'repository.commit_sha', 40);
  const treeSha = text(repository.tree_sha, 'repository.tree_sha', 40);
  if (!SHA1.test(commitSha) || !SHA1.test(treeSha)) {
    reject('preview: identidad exact-main inválida.');
  }

  return {
    schema_version: 1,
    package: { name, version },
    repository: {
      commit_sha: commitSha,
      tree_sha: treeSha,
    },
    fingerprints: {
      receipt_sha256: fingerprint(evidence.receipt_sha256, 'receipt_sha256'),
      source_sha256: fingerprint(evidence.source_sha256, 'source_sha256'),
      binding_sha256: fingerprint(evidence.binding_sha256, 'binding_sha256'),
      preflight_sha256: fingerprint(evidence.preflight_sha256, 'preflight_sha256'),
      handoff_sha256: fingerprint(verified.handoff_sha256, 'handoff_sha256'),
    },
    authority: 'unchanged',
    decision_required: true,
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  };
}

const preview = JSON.stringify(project(runVerifier(process.argv.slice(2)))) + '\n';
if (Buffer.byteLength(preview, 'utf8') > MAX_OUTPUT_BYTES) {
  reject('preview: salida fuera de límites.');
}
process.stdout.write(preview);
