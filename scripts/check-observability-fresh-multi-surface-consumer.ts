import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  receipt: string;
  artifact: string;
  provenance: string;
  dependencies: string;
  preflight: string;
  verifiedHandoff: string;
  freshPreview: string;
}>;

type ReceiptProof = Readonly<{
  receiptSha256: string;
  artifactSha256: string;
  packageVersion: string;
}>;

type FreshProof = Readonly<{
  receiptSha256: string;
  artifactSha256: string;
  handoffSha256: string;
  packageVersion: string;
  commitSha: string;
  treeSha: string;
}>;

const RECEIPT_VERIFIER = fileURLToPath(
  new URL('./check-observability-package-release-receipt.ts', import.meta.url),
);
const FRESH_BINDING = fileURLToPath(
  new URL('./create-observability-fresh-artifact-binding.ts', import.meta.url),
);
const VERIFIED_CONSUMER = fileURLToPath(
  new URL('./check-observability-package-verified-consumer.ts', import.meta.url),
);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED_PACKAGE = '@pl0n3r/factoryrunner';
const RECOVERY_SUBPATH = EXPECTED_PACKAGE + '/recovery-handoff';
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_STDOUT = 1024 * 1024;
const MAX_BINDING = 4096;
const FLAGS = [
  '--receipt',
  '--artifact',
  '--provenance',
  '--dependencies',
  '--preflight',
  '--verified-handoff',
  '--fresh-preview',
] as const;

function reject(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    reject(label + ': objeto JSON inválido.');
  }
  return value as JsonObject;
}

function hash(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !SHA256.test(value)
    || /^0{64}$/.test(value)
  ) {
    reject(label + ': SHA-256 inválido o UNKNOWN.');
  }
  return value;
}

function packageVersion(value: unknown, label: string): string {
  const packageValue = record(value, label);
  if (
    packageValue.name !== EXPECTED_PACKAGE
    || typeof packageValue.version !== 'string'
    || !VERSION.test(packageValue.version)
  ) {
    reject(label + ': package identity inválida.');
  }
  return packageValue.version;
}

function options(argv: readonly string[]): Options {
  if (argv.length !== FLAGS.length * 2) reject('Argumentos inválidos.');
  const values: string[] = [];
  FLAGS.forEach((flag, index) => {
    const value = argv[(index * 2) + 1];
    if (
      argv[index * 2] !== flag
      || typeof value !== 'string'
      || value.trim() === ''
    ) {
      reject('Argumentos inválidos.');
    }
    values.push(resolve(value));
  });
  return Object.freeze({
    receipt: values[0],
    artifact: values[1],
    provenance: values[2],
    dependencies: values[3],
    preflight: values[4],
    verifiedHandoff: values[5],
    freshPreview: values[6],
  });
}

async function runLocal(
  script: string,
  args: readonly string[],
  label: string,
  timeout: number,
): Promise<string> {
  const metadata = await lstat(script);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    reject(label + ': ejecutable canónico inválido.');
  }
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: MAX_STDOUT,
      windowsHide: true,
    },
  );
  if (
    run.error !== undefined
    || run.status !== 0
    || run.signal !== null
    || typeof run.stdout !== 'string'
    || Buffer.byteLength(run.stdout, 'utf8') > MAX_STDOUT
  ) {
    reject(label + ': contrato local rechazado.');
  }
  return run.stdout;
}

function json(stdout: string, label: string): JsonObject {
  if (Buffer.byteLength(stdout, 'utf8') === 0) {
    reject(label + ': salida vacía.');
  }
  try {
    return record(JSON.parse(stdout) as unknown, label);
  } catch {
    reject(label + ': salida JSON inválida.');
  }
}

function receiptProof(value: JsonObject): ReceiptProof {
  if (
    value.verified !== true
    || value.authority !== 'unchanged'
    || value.network_access !== false
    || value.external_mutation !== false
  ) {
    reject('verified receipt: autoridad inválida.');
  }
  return Object.freeze({
    receiptSha256: hash(value.receipt_sha256, 'verified receipt.receipt_sha256'),
    artifactSha256: hash(value.artifact_sha256, 'verified receipt.artifact_sha256'),
    packageVersion: packageVersion(value.package, 'verified receipt.package'),
  });
}

async function freshProof(path: string): Promise<FreshProof> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > MAX_BINDING
  ) {
    reject('fresh binding: archivo inválido.');
  }
  const root = json(await readFile(path, 'utf8'), 'fresh binding');
  const evidence = record(root.evidence, 'fresh binding.evidence');
  const repository = record(root.repository, 'fresh binding.repository');
  const verification = record(root.verification, 'fresh binding.verification');
  const verificationKeys = [
    'receipt_verified',
    'handoff_verified',
    'handoff_fresh',
    'package_match',
    'artifact_match',
    'receipt_match',
    'handoff_match',
    'repository_match',
  ] as const;

  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
    || verificationKeys.some((key) => verification[key] !== true)
    || typeof repository.commit_sha !== 'string'
    || !SHA1.test(repository.commit_sha)
    || /^0{40}$/.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1.test(repository.tree_sha)
    || /^0{40}$/.test(repository.tree_sha)
    || repository.commit_sha === repository.tree_sha
  ) {
    reject('fresh binding: contrato rechazado.');
  }

  return Object.freeze({
    receiptSha256: hash(evidence.receipt_sha256, 'fresh binding.receipt'),
    artifactSha256: hash(evidence.artifact_sha256, 'fresh binding.artifact'),
    handoffSha256: hash(evidence.handoff_sha256, 'fresh binding.handoff'),
    packageVersion: packageVersion(root.package, 'fresh binding.package'),
    commitSha: repository.commit_sha,
    treeSha: repository.tree_sha,
  });
}

function assertConsumer(value: JsonObject, expected: FreshProof): void {
  const surfaces = value.public_surfaces_consumed;
  const reasons = value.recovery_compatibility_reasons;
  if (
    value.verified !== true
    || value.installed_from_local_artifact !== true
    || value.public_api_consumed !== true
    || !Array.isArray(surfaces)
    || surfaces.length !== 2
    || surfaces[0] !== EXPECTED_PACKAGE
    || surfaces[1] !== RECOVERY_SUBPATH
    || value.packet_status !== 'READY'
    || value.packet_authority !== 'unchanged'
    || value.recovery_manifest_authority !== 'unchanged'
    || value.recovery_manifest_execution !== false
    || value.recovery_manifest_network_access !== false
    || value.recovery_manifest_external_mutation !== false
    || value.recovery_compatibility_status !== 'COMPATIBLE'
    || value.recovery_compatibility_authority !== 'unchanged'
    || !Array.isArray(reasons)
    || reasons.length !== 0
    || value.recovery_compatibility_execution !== false
    || value.recovery_compatibility_network_access !== false
    || value.recovery_compatibility_external_mutation !== false
    || value.authority !== 'unchanged'
    || value.execution !== false
    || value.network_access !== false
    || value.external_mutation !== false
    || hash(value.receipt_sha256, 'consumer.receipt') !== expected.receiptSha256
    || hash(value.artifact_sha256, 'consumer.artifact') !== expected.artifactSha256
    || packageVersion(value.package, 'consumer.package') !== expected.packageVersion
  ) {
    reject('verified consumer: contrato o binding divergente.');
  }
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2));
  const receiptArgs = [
    '--receipt', input.receipt,
    '--artifact', input.artifact,
    '--provenance', input.provenance,
    '--dependencies', input.dependencies,
    '--preflight', input.preflight,
  ] as const;
  const verifiedReceiptStdout = await runLocal(
    RECEIPT_VERIFIER,
    receiptArgs,
    'receipt verifier',
    60_000,
  );
  const receipt = receiptProof(json(verifiedReceiptStdout, 'verified receipt'));

  const workspace = await mkdtemp(join(tmpdir(), 'factoryrunner-fresh-consumer-'));
  const receiptPath = join(workspace, 'verified-receipt.json');
  const bindingPath = join(workspace, 'fresh-binding.json');
  try {
    await writeFile(receiptPath, verifiedReceiptStdout, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await runLocal(
      FRESH_BINDING,
      [
        '--verified-receipt', receiptPath,
        '--verified-handoff', input.verifiedHandoff,
        '--fresh-preview', input.freshPreview,
        '--output', bindingPath,
      ],
      'fresh binding',
      30_000,
    );
    const binding = await freshProof(bindingPath);
    if (
      binding.receiptSha256 !== receipt.receiptSha256
      || binding.artifactSha256 !== receipt.artifactSha256
      || binding.packageVersion !== receipt.packageVersion
    ) {
      reject('fresh binding: no corresponde al verified receipt.');
    }

    const consumer = json(
      await runLocal(
        VERIFIED_CONSUMER,
        receiptArgs,
        'verified consumer',
        120_000,
      ),
      'verified consumer',
    );
    assertConsumer(consumer, binding);

    process.stdout.write(JSON.stringify({
      verified: true,
      fresh_exact_main_binding: true,
      repository: {
        commit_sha: binding.commitSha,
        tree_sha: binding.treeSha,
      },
      evidence: {
        artifact_sha256: binding.artifactSha256,
        receipt_sha256: binding.receiptSha256,
        handoff_sha256: binding.handoffSha256,
      },
      installed_from_local_artifact: true,
      public_surfaces_consumed: [EXPECTED_PACKAGE, RECOVERY_SUBPATH],
      packet_status: 'READY',
      recovery_compatibility_status: 'COMPATIBLE',
      authority: 'unchanged',
      execution: false,
      network_access: false,
      external_mutation: false,
    }) + '\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
