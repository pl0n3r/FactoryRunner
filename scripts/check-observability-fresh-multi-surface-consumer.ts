import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

type ReceiptVerification = Readonly<{
  verified: true;
  receipt_sha256: string;
  artifact_sha256: string;
  package: Readonly<{
    name: string;
    version: string;
    private: true;
    type: 'module';
  }>;
  authority: 'unchanged';
  network_access: false;
  external_mutation: false;
}>;

type FreshBinding = Readonly<{
  schema_version: 1;
  package: ReceiptVerification['package'];
  evidence: Readonly<{
    artifact_sha256: string;
    receipt_sha256: string;
    handoff_sha256: string;
  }>;
  repository: Readonly<{
    commit_sha: string;
    tree_sha: string;
  }>;
  verification: Readonly<{
    artifact_match: true;
    handoff_fresh: true;
    handoff_match: true;
    handoff_verified: true;
    package_match: true;
    receipt_match: true;
    receipt_verified: true;
    repository_match: true;
  }>;
  authority: 'unchanged';
  publish_authority: false;
  network_access: false;
  external_mutation: false;
}>;

type ConsumerResult = Readonly<{
  verified: true;
  installed_from_local_artifact: true;
  public_api_consumed: true;
  public_surfaces_consumed: readonly [
    '@pl0n3r/factoryrunner',
    '@pl0n3r/factoryrunner/recovery-handoff',
  ];
  receipt_sha256: string;
  artifact_sha256: string;
  packet_status: 'READY';
  packet_authority: 'unchanged';
  recovery_compatibility_status: 'COMPATIBLE';
  recovery_compatibility_authority: 'unchanged';
  recovery_compatibility_reasons: readonly [];
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
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
const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const LIMITS = Object.freeze({
  json: 16 * 1024,
  stdout: 1024 * 1024,
});

function fail(message: string): never {
  throw new Error(message);
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
      !flags.includes(flag as typeof flags[number])
      || value === undefined
      || value.trim() === ''
      || values.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    values.set(flag, value);
  }
  if (flags.some((flag) => !values.has(flag))) fail('Falta input requerido.');

  return Object.freeze({
    receipt: resolve(values.get('--receipt') as string),
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
    preflight: resolve(values.get('--preflight') as string),
    verifiedHandoff: resolve(values.get('--verified-handoff') as string),
    freshPreview: resolve(values.get('--fresh-preview') as string),
  });
}

function runJson(
  script: string,
  args: readonly string[],
  label: string,
  timeout: number,
): JsonObject {
  const completed = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: LIMITS.stdout,
    },
  );
  if (
    completed.error !== undefined
    || completed.status !== 0
    || typeof completed.stdout !== 'string'
    || Buffer.byteLength(completed.stdout, 'utf8') <= 0
    || Buffer.byteLength(completed.stdout, 'utf8') > LIMITS.stdout
  ) {
    fail(label + ': contrato local rechazado.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(completed.stdout) as unknown;
  } catch {
    fail(label + ': salida JSON inválida.');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    fail(label + ': objeto JSON requerido.');
  }
  return parsed as JsonObject;
}

function exactObject(
  value: unknown,
  label: string,
  fields: readonly string[],
): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(label + ': objeto requerido.');
  }
  const object = value as JsonObject;
  const actual = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(label + ': schema desconocido o incompleto.');
  }
  return object;
}

function sha256(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !SHA256_RE.test(value)
    || /^0{64}$/.test(value)
  ) {
    fail(label + ': SHA-256 inválido o UNKNOWN.');
  }
  return value;
}

function packageIdentity(value: unknown, label: string): ReceiptVerification['package'] {
  const object = exactObject(value, label, ['name', 'version', 'private', 'type']);
  if (
    object.name !== ROOT_PACKAGE
    || typeof object.version !== 'string'
    || !VERSION_RE.test(object.version)
    || object.private !== true
    || object.type !== 'module'
  ) {
    fail(label + ': identidad de package inválida.');
  }
  return Object.freeze({
    name: ROOT_PACKAGE,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function receiptVerification(value: JsonObject): ReceiptVerification {
  const object = exactObject(value, 'verified receipt', [
    'verified',
    'receipt_sha256',
    'artifact_sha256',
    'package',
    'authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    object.verified !== true
    || object.authority !== 'unchanged'
    || object.network_access !== false
    || object.external_mutation !== false
  ) {
    fail('verified receipt: autoridad o verificación inválida.');
  }
  return Object.freeze({
    verified: true,
    receipt_sha256: sha256(object.receipt_sha256, 'verified receipt.receipt_sha256'),
    artifact_sha256: sha256(object.artifact_sha256, 'verified receipt.artifact_sha256'),
    package: packageIdentity(object.package, 'verified receipt.package'),
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  });
}

async function readFreshBinding(path: string): Promise<FreshBinding> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > LIMITS.json
  ) {
    fail('fresh binding: archivo local inválido.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    fail('fresh binding: JSON inválido.');
  }
  const root = exactObject(parsed, 'fresh binding', [
    'schema_version',
    'package',
    'evidence',
    'repository',
    'verification',
    'authority',
    'publish_authority',
    'network_access',
    'external_mutation',
  ]);
  if (
    root.schema_version !== 1
    || root.authority !== 'unchanged'
    || root.publish_authority !== false
    || root.network_access !== false
    || root.external_mutation !== false
  ) {
    fail('fresh binding: autoridad inválida.');
  }

  const evidence = exactObject(root.evidence, 'fresh binding.evidence', [
    'artifact_sha256',
    'receipt_sha256',
    'handoff_sha256',
  ]);
  const repository = exactObject(root.repository, 'fresh binding.repository', [
    'commit_sha',
    'tree_sha',
  ]);
  const verification = exactObject(
    root.verification,
    'fresh binding.verification',
    [
      'artifact_match',
      'handoff_fresh',
      'handoff_match',
      'handoff_verified',
      'package_match',
      'receipt_match',
      'receipt_verified',
      'repository_match',
    ],
  );
  if (
    Object.values(verification).some((entry) => entry !== true)
    || typeof repository.commit_sha !== 'string'
    || !SHA1_RE.test(repository.commit_sha)
    || /^0{40}$/.test(repository.commit_sha)
    || typeof repository.tree_sha !== 'string'
    || !SHA1_RE.test(repository.tree_sha)
    || /^0{40}$/.test(repository.tree_sha)
  ) {
    fail('fresh binding: verificación o repository identity inválida.');
  }

  return Object.freeze({
    schema_version: 1,
    package: packageIdentity(root.package, 'fresh binding.package'),
    evidence: Object.freeze({
      artifact_sha256: sha256(
        evidence.artifact_sha256,
        'fresh binding.evidence.artifact_sha256',
      ),
      receipt_sha256: sha256(
        evidence.receipt_sha256,
        'fresh binding.evidence.receipt_sha256',
      ),
      handoff_sha256: sha256(
        evidence.handoff_sha256,
        'fresh binding.evidence.handoff_sha256',
      ),
    }),
    repository: Object.freeze({
      commit_sha: repository.commit_sha,
      tree_sha: repository.tree_sha,
    }),
    verification: Object.freeze({
      artifact_match: true,
      handoff_fresh: true,
      handoff_match: true,
      handoff_verified: true,
      package_match: true,
      receipt_match: true,
      receipt_verified: true,
      repository_match: true,
    }),
    authority: 'unchanged',
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  });
}

function consumerResult(value: JsonObject): ConsumerResult {
  const required = [
    'verified',
    'installed_from_local_artifact',
    'public_api_consumed',
    'public_surfaces_consumed',
    'receipt_sha256',
    'artifact_sha256',
    'package',
    'packet_status',
    'packet_authority',
    'recovery_manifest_authority',
    'recovery_manifest_execution',
    'recovery_manifest_network_access',
    'recovery_manifest_external_mutation',
    'recovery_compatibility_status',
    'recovery_compatibility_authority',
    'recovery_compatibility_reasons',
    'recovery_compatibility_execution',
    'recovery_compatibility_network_access',
    'recovery_compatibility_external_mutation',
    'authority',
    'execution',
    'network_access',
    'external_mutation',
  ];
  const object = exactObject(value, 'verified consumer', required);
  const surfaces = object.public_surfaces_consumed;
  const reasons = object.recovery_compatibility_reasons;
  if (
    object.verified !== true
    || object.installed_from_local_artifact !== true
    || object.public_api_consumed !== true
    || !Array.isArray(surfaces)
    || surfaces.length !== 2
    || surfaces[0] !== ROOT_PACKAGE
    || surfaces[1] !== RECOVERY_SUBPATH
    || object.packet_status !== 'READY'
    || object.packet_authority !== 'unchanged'
    || object.recovery_manifest_authority !== 'unchanged'
    || object.recovery_manifest_execution !== false
    || object.recovery_manifest_network_access !== false
    || object.recovery_manifest_external_mutation !== false
    || object.recovery_compatibility_status !== 'COMPATIBLE'
    || object.recovery_compatibility_authority !== 'unchanged'
    || !Array.isArray(reasons)
    || reasons.length !== 0
    || object.recovery_compatibility_execution !== false
    || object.recovery_compatibility_network_access !== false
    || object.recovery_compatibility_external_mutation !== false
    || object.authority !== 'unchanged'
    || object.execution !== false
    || object.network_access !== false
    || object.external_mutation !== false
  ) {
    fail('verified consumer: superficies o autoridad inválidas.');
  }
  packageIdentity(object.package, 'verified consumer.package');
  return Object.freeze({
    verified: true,
    installed_from_local_artifact: true,
    public_api_consumed: true,
    public_surfaces_consumed: Object.freeze([
      ROOT_PACKAGE,
      RECOVERY_SUBPATH,
    ]),
    receipt_sha256: sha256(object.receipt_sha256, 'verified consumer.receipt_sha256'),
    artifact_sha256: sha256(object.artifact_sha256, 'verified consumer.artifact_sha256'),
    packet_status: 'READY',
    packet_authority: 'unchanged',
    recovery_compatibility_status: 'COMPATIBLE',
    recovery_compatibility_authority: 'unchanged',
    recovery_compatibility_reasons: Object.freeze([]),
    authority: 'unchanged',
    execution: false,
    network_access: false,
    external_mutation: false,
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
      JSON.stringify(verifiedReceipt, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    const bindingCompleted = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        FRESH_BINDING,
        '--verified-receipt', verifiedReceiptPath,
        '--verified-handoff', options.verifiedHandoff,
        '--fresh-preview', options.freshPreview,
        '--output', bindingPath,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: LIMITS.stdout,
      },
    );
    if (bindingCompleted.error !== undefined || bindingCompleted.status !== 0) {
      fail('fresh binding: evidencia stale, mixed o tampered.');
    }

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
    ) {
      fail('verified consumer: artifact/receipt no coincide con fresh binding.');
    }

    process.stdout.write(JSON.stringify({
      verified: true,
      fresh_exact_main_binding: true,
      repository: binding.repository,
      evidence: binding.evidence,
      installed_from_local_artifact: consumed.installed_from_local_artifact,
      public_surfaces_consumed: consumed.public_surfaces_consumed,
      packet_status: consumed.packet_status,
      recovery_compatibility_status: consumed.recovery_compatibility_status,
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
