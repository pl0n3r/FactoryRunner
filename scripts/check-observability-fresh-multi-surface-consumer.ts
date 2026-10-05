import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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

type Identity = Readonly<{ name: string; version: string }>;

type ReceiptVerification = Readonly<{
  receipt_sha256: string;
  artifact_sha256: string;
  package: Identity;
}>;

type FreshBinding = Readonly<{
  package: Identity;
  evidence: Readonly<{
    artifact_sha256: string;
    receipt_sha256: string;
    handoff_sha256: string;
  }>;
  repository: Readonly<{
    commit_sha: string;
    tree_sha: string;
  }>;
}>;

type ConsumerResult = Readonly<{
  artifact_sha256: string;
  receipt_sha256: string;
  package: Identity;
  public_surfaces_consumed: readonly string[];
}>;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECEIPT_VERIFIER = resolve(
  ROOT,
  'scripts',
  'check-observability-package-release-receipt.ts',
);
const FRESH_BINDING = resolve(
  ROOT,
  'scripts',
  'create-observability-fresh-artifact-binding.ts',
);
const VERIFIED_CONSUMER = resolve(
  ROOT,
  'scripts',
  'check-observability-package-verified-consumer.ts',
);
const ROOT_PACKAGE = '@pl0n3r/factoryrunner';
const RECOVERY_SUBPATH = ROOT_PACKAGE + '/recovery-handoff';
const MAX_STDOUT = 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(label + ': objeto JSON requerido.');
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(label + ': texto requerido.');
  }
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = [
    '--receipt',
    '--artifact',
    '--provenance',
    '--dependencies',
    '--preflight',
    '--verified-handoff',
    '--fresh-preview',
  ] as const;
  if (argv.length !== flags.length * 2) fail('Argumentos inválidos.');

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      value === undefined
      || value.trim() === ''
      || !flags.includes(flag as typeof flags[number])
      || values.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    values.set(flag, value);
  }

  const resolved = (flag: typeof flags[number]): string => {
    const value = values.get(flag);
    if (value === undefined) fail('Falta input requerido.');
    return resolve(value);
  };

  return Object.freeze({
    receipt: resolved('--receipt'),
    artifact: resolved('--artifact'),
    provenance: resolved('--provenance'),
    dependencies: resolved('--dependencies'),
    preflight: resolved('--preflight'),
    verifiedHandoff: resolved('--verified-handoff'),
    freshPreview: resolved('--fresh-preview'),
  });
}

function runLocal(
  script: string,
  args: readonly string[],
  label: string,
  timeout: number,
): string {
  const completed = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: MAX_STDOUT,
    },
  );
  if (
    completed.error !== undefined
    || completed.status !== 0
    || typeof completed.stdout !== 'string'
  ) {
    fail(label + ': contrato local rechazado.');
  }
  return completed.stdout;
}

function runJson(
  script: string,
  args: readonly string[],
  label: string,
  timeout: number,
): JsonObject {
  const stdout = runLocal(script, args, label, timeout);
  if (stdout.length === 0) fail(label + ': salida vacía.');
  try {
    return object(JSON.parse(stdout) as unknown, label);
  } catch {
    fail(label + ': salida JSON inválida.');
  }
}

function packageIdentity(value: unknown, label: string): Identity {
  const packageValue = object(value, label);
  const name = text(packageValue.name, label + '.name');
  const version = text(packageValue.version, label + '.version');
  if (name !== ROOT_PACKAGE) fail(label + ': package inesperado.');
  return Object.freeze({ name, version });
}

function receiptVerification(value: JsonObject): ReceiptVerification {
  if (
    value.verified !== true
    || value.authority !== 'unchanged'
    || value.network_access !== false
    || value.external_mutation !== false
  ) {
    fail('verified receipt: autoridad inválida.');
  }
  return Object.freeze({
    receipt_sha256: text(value.receipt_sha256, 'verified receipt.receipt_sha256'),
    artifact_sha256: text(value.artifact_sha256, 'verified receipt.artifact_sha256'),
    package: packageIdentity(value.package, 'verified receipt.package'),
  });
}

async function readFreshBinding(path: string): Promise<FreshBinding> {
  let parsed: JsonObject;
  try {
    parsed = object(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
      'fresh binding',
    );
  } catch {
    fail('fresh binding: JSON inválido.');
  }

  if (
    parsed.schema_version !== 1
    || parsed.authority !== 'unchanged'
    || parsed.publish_authority !== false
    || parsed.network_access !== false
    || parsed.external_mutation !== false
  ) {
    fail('fresh binding: autoridad inválida.');
  }

  const verification = object(parsed.verification, 'fresh binding.verification');
  for (const key of [
    'artifact_match',
    'handoff_fresh',
    'handoff_match',
    'handoff_verified',
    'package_match',
    'receipt_match',
    'receipt_verified',
    'repository_match',
  ]) {
    if (verification[key] !== true) {
      fail('fresh binding: verificación incompleta.');
    }
  }

  const evidence = object(parsed.evidence, 'fresh binding.evidence');
  const repository = object(parsed.repository, 'fresh binding.repository');
  return Object.freeze({
    package: packageIdentity(parsed.package, 'fresh binding.package'),
    evidence: Object.freeze({
      artifact_sha256: text(evidence.artifact_sha256, 'binding artifact'),
      receipt_sha256: text(evidence.receipt_sha256, 'binding receipt'),
      handoff_sha256: text(evidence.handoff_sha256, 'binding handoff'),
    }),
    repository: Object.freeze({
      commit_sha: text(repository.commit_sha, 'binding commit'),
      tree_sha: text(repository.tree_sha, 'binding tree'),
    }),
  });
}

function consumerResult(value: JsonObject): ConsumerResult {
  const surfaces = value.public_surfaces_consumed;
  const reasons = value.recovery_compatibility_reasons;
  if (
    value.verified !== true
    || value.installed_from_local_artifact !== true
    || value.public_api_consumed !== true
    || !Array.isArray(surfaces)
    || surfaces.length !== 2
    || surfaces[0] !== ROOT_PACKAGE
    || surfaces[1] !== RECOVERY_SUBPATH
    || value.packet_status !== 'READY'
    || value.packet_authority !== 'unchanged'
    || value.recovery_compatibility_status !== 'COMPATIBLE'
    || value.recovery_compatibility_authority !== 'unchanged'
    || !Array.isArray(reasons)
    || reasons.length !== 0
    || value.authority !== 'unchanged'
    || value.execution !== false
    || value.network_access !== false
    || value.external_mutation !== false
  ) {
    fail('verified consumer: resultado incompatible.');
  }
  return Object.freeze({
    artifact_sha256: text(value.artifact_sha256, 'consumer artifact'),
    receipt_sha256: text(value.receipt_sha256, 'consumer receipt'),
    package: packageIdentity(value.package, 'verified consumer.package'),
    public_surfaces_consumed: Object.freeze([ROOT_PACKAGE, RECOVERY_SUBPATH]),
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const verifiedReceipt = receiptVerification(
    runJson(
      RECEIPT_VERIFIER,
      [
        '--receipt', options.receipt,
        '--artifact', options.artifact,
        '--provenance', options.provenance,
        '--dependencies', options.dependencies,
        '--preflight', options.preflight,
      ],
      'receipt verifier',
      60_000,
    ),
  );

  const workspace = await mkdtemp(join(tmpdir(), 'factoryrunner-fresh-consumer-'));
  const verifiedReceiptPath = join(workspace, 'verified-receipt.json');
  const bindingPath = join(workspace, 'fresh-binding.json');

  try {
    await writeFile(
      verifiedReceiptPath,
      JSON.stringify({
        verified: true,
        receipt_sha256: verifiedReceipt.receipt_sha256,
        artifact_sha256: verifiedReceipt.artifact_sha256,
        package: {
          name: verifiedReceipt.package.name,
          version: verifiedReceipt.package.version,
          private: true,
          type: 'module',
        },
        authority: 'unchanged',
        network_access: false,
        external_mutation: false,
      }, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    runLocal(
      FRESH_BINDING,
      [
        '--verified-receipt', verifiedReceiptPath,
        '--verified-handoff', options.verifiedHandoff,
        '--fresh-preview', options.freshPreview,
        '--output', bindingPath,
      ],
      'fresh binding',
      30_000,
    );

    const binding = await readFreshBinding(bindingPath);
    if (
      binding.evidence.artifact_sha256 !== verifiedReceipt.artifact_sha256
      || binding.evidence.receipt_sha256 !== verifiedReceipt.receipt_sha256
      || binding.package.name !== verifiedReceipt.package.name
      || binding.package.version !== verifiedReceipt.package.version
    ) {
      fail('fresh binding: no corresponde al artifact/receipt verificado.');
    }

    const consumed = consumerResult(
      runJson(
        VERIFIED_CONSUMER,
        [
          '--receipt', options.receipt,
          '--artifact', options.artifact,
          '--provenance', options.provenance,
          '--dependencies', options.dependencies,
          '--preflight', options.preflight,
        ],
        'verified consumer',
        120_000,
      ),
    );

    if (
      consumed.artifact_sha256 !== binding.evidence.artifact_sha256
      || consumed.receipt_sha256 !== binding.evidence.receipt_sha256
      || consumed.package.version !== binding.package.version
    ) {
      fail('verified consumer: artifact/receipt no coincide con fresh binding.');
    }

    process.stdout.write(JSON.stringify({
      verified: true,
      fresh_exact_main_binding: true,
      repository: binding.repository,
      evidence: binding.evidence,
      installed_from_local_artifact: true,
      public_surfaces_consumed: consumed.public_surfaces_consumed,
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
