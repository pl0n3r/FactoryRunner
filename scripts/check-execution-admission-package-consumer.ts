import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { capabilityManifest } from '../src/capability-manifest.ts';
import {
  executionAdmissionPublicCompatibility,
  type ExecutionAdmissionPublicCompatibility,
} from '../src/execution-admission-public-compatibility.ts';
import { executionAdmissionPublicManifest } from '../src/execution-admission-public-manifest.ts';
import { resourceSnapshot } from '../src/resource-snapshot.ts';
import { parseRunnerIdentity } from '../src/runner.ts';

type Options = Readonly<{
  receipt: string;
  artifact: string;
  provenance: string;
  dependencies: string;
  preflight: string;
  requirements: string;
}>;

type Verification = Readonly<{
  verified: true;
  receipt_sha256: string;
  artifact_sha256: string;
  package: Readonly<{ name: string; version: string }>;
  authority: 'unchanged';
  network_access: false;
  external_mutation: false;
}>;

type Fixture = Readonly<{
  identity: unknown;
  order: unknown;
  manifest: unknown;
  resource: unknown;
  now: number;
}>;

type ConsumedAdmission = Readonly<{
  decision: 'ALLOW';
  decision_authority: 'unchanged';
  decision_fingerprint: string;
  evidence_decision: 'ALLOW';
  evidence_authority: 'unchanged';
  evidence_decision_fingerprint: string;
  evidence_fingerprint: string;
  public_import: typeof EXECUTION_ADMISSION_SUBPATH;
  authority: 'unchanged';
  network_access: false;
  external_mutation: false;
}>;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VERIFIER = resolve(ROOT, 'scripts', 'check-observability-package-release-receipt.ts');
const EXPECTED_PACKAGE = '@pl0n3r/factoryrunner';
const EXECUTION_ADMISSION_SUBPATH = EXPECTED_PACKAGE + '/execution-admission';
const NPM_CLI = resolve(
  dirname(process.execPath),
  '..',
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const MAX_BUFFER = 1024 * 1024;
const REQUIREMENTS_LIMIT = 64 * 1024;

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
    '--requirements',
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
    requirements: resolve(values.get('--requirements') as string),
  });
}

async function localBytes(path: string, maximum: number, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > maximum
  ) {
    fail(label + ': archivo local inválido.');
  }
  return readFile(path);
}

async function expectedPackageVersion(): Promise<string> {
  const body = await localBytes(resolve(ROOT, 'package.json'), REQUIREMENTS_LIMIT, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail('package.json inválido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('package.json inválido.');
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('Versión local inválida.');
  }
  return version;
}

function verifyReceipt(options: Options, expectedVersion: string): Verification {
  const completed = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      VERIFIER,
      '--receipt',
      options.receipt,
      '--artifact',
      options.artifact,
      '--provenance',
      options.provenance,
      '--dependencies',
      options.dependencies,
      '--preflight',
      options.preflight,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (completed.error !== undefined || completed.status !== 0) {
    fail('Release receipt no verificado; consumo bloqueado.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(completed.stdout) as unknown;
  } catch {
    fail('Verifier produjo salida inválida.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('Verifier produjo salida inválida.');
  }
  const result = parsed as Record<string, unknown>;
  if (
    result.verified !== true
    || result.authority !== 'unchanged'
    || result.network_access !== false
    || result.external_mutation !== false
    || typeof result.receipt_sha256 !== 'string'
    || typeof result.artifact_sha256 !== 'string'
    || typeof result.package !== 'object'
    || result.package === null
    || Array.isArray(result.package)
  ) {
    fail('Verifier no confirmó evidencia local esperada.');
  }
  const packageValue = result.package as Record<string, unknown>;
  if (
    packageValue.name !== EXPECTED_PACKAGE
    || packageValue.version !== expectedVersion
  ) {
    fail('Identidad exacta del paquete no coincide.');
  }

  return Object.freeze({
    verified: true,
    receipt_sha256: result.receipt_sha256,
    artifact_sha256: result.artifact_sha256,
    package: Object.freeze({
      name: EXPECTED_PACKAGE,
      version: expectedVersion,
    }),
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  });
}

async function verifyCompatibility(options: Options): Promise<ExecutionAdmissionPublicCompatibility> {
  const body = await localBytes(options.requirements, REQUIREMENTS_LIMIT, 'requirements');
  let requirements: unknown;
  try {
    requirements = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail('Requirements de compatibilidad inválidos.');
  }

  const manifest = executionAdmissionPublicManifest();
  const compatibility = executionAdmissionPublicCompatibility(manifest, requirements);
  if (
    compatibility.status !== 'COMPATIBLE'
    || compatibility.authority !== 'unchanged'
    || compatibility.reasons.length !== 0
    || compatibility.execution !== false
    || compatibility.network_access !== false
    || compatibility.external_mutation !== false
    || compatibility.manifest_fingerprint !== manifest.fingerprint
  ) {
    fail('Compatibilidad pública Execution Admission rechazada.');
  }
  return compatibility;
}

function buildFixture(): Fixture {
  const runnerId = '11111111-1111-7111-8111-111111111111';
  const now = 1200;
  const identity = parseRunnerIdentity({
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'test',
    capabilities: ['git.head'],
    max_parallel: 1,
  });
  const manifest = capabilityManifest(identity, [{
    id: 'git-adapter',
    capabilities: ['git.head'],
  }]);
  const order = Object.freeze({
    version: 1,
    order_id: '22222222-2222-7222-8222-222222222222',
    work_item_id: 'factoryrunner:work:407',
    runner_id: runnerId,
    capability: 'git.head',
    attempt: 1,
    issued_at: 1100,
    expires_at: 1300,
    instruction_ref: 'controlbot:instruction:factoryrunner-407',
  });
  const resource = resourceSnapshot(
    identity,
    {
      version: 1,
      runner_id: runnerId,
      sequence: 7,
      observed_at: 1190,
      status: 'ready',
      capacity: { max: 1, active: 0 },
      active_sessions: [],
    },
    {
      version: 1,
      runner_id: runnerId,
      observed_at: 1190,
      queued_orders: 1,
    },
    now,
    30,
  );

  return Object.freeze({ identity, order, manifest, resource, now });
}

function npmEnvironment(cache: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: cache,
  };
}

async function consumeVerifiedArtifact(
  options: Options,
  fixture: Fixture,
): Promise<ConsumedAdmission> {
  const npmMetadata = await lstat(NPM_CLI);
  if (!npmMetadata.isFile() || npmMetadata.isSymbolicLink()) {
    fail('npm CLI canónico no disponible.');
  }

  const root = await mkdtemp(join(tmpdir(), 'factoryrunner-execution-admission-consumer-'));
  try {
    const consumer = join(root, 'consumer');
    const cache = join(root, 'npm-cache');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'factoryrunner-execution-admission-consumer-fixture',
        private: true,
        type: 'module',
      }) + '\n',
      'utf8',
    );

    const install = spawnSync(
      process.execPath,
      [
        NPM_CLI,
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--save-exact',
        options.artifact,
      ],
      {
        cwd: root,
        env: npmEnvironment(cache),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error !== undefined || install.status !== 0) {
      fail('Instalación local offline rechazada.');
    }

    const script = join(root, 'consumer.mjs');
    const fixtureJson = JSON.stringify(fixture);
    await writeFile(
      script,
      `import {
  admissionEvidence,
  executionAdmissionDecision,
} from '@pl0n3r/factoryrunner/execution-admission';

const fixture = ${fixtureJson};
const decision = executionAdmissionDecision(
  fixture.identity,
  fixture.order,
  fixture.manifest,
  fixture.resource,
  fixture.now,
);
const evidence = admissionEvidence(decision);
const serialized = JSON.stringify({ decision, evidence });
for (const forbidden of [
  'instruction_ref',
  'controlbot:instruction',
  'payload',
  'adapters',
  'capabilities',
  'secret',
  'token',
]) {
  if (serialized.toLowerCase().includes(forbidden)) {
    throw new Error('Salida pública contiene material no permitido.');
  }
}
process.stdout.write(JSON.stringify({
  decision: decision.decision,
  decision_authority: decision.authority,
  decision_fingerprint: decision.fingerprint,
  evidence_decision: evidence.decision,
  evidence_authority: evidence.authority,
  evidence_decision_fingerprint: evidence.decision_fingerprint,
  evidence_fingerprint: evidence.fingerprint,
  public_import: '@pl0n3r/factoryrunner/execution-admission',
  authority: 'unchanged',
  network_access: false,
  external_mutation: false,
}));
`,
      'utf8',
    );

    const consumed = spawnSync(process.execPath, [script], {
      cwd: consumer === root ? consumer : root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    });
    if (consumed.error !== undefined || consumed.status !== 0) {
      fail('Consumo de Execution Admission rechazado.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(consumed.stdout) as unknown;
    } catch {
      fail('Consumer produjo salida inválida.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('Consumer produjo salida inválida.');
    }
    const result = parsed as Record<string, unknown>;
    if (
      result.decision !== 'ALLOW'
      || result.decision_authority !== 'unchanged'
      || typeof result.decision_fingerprint !== 'string'
      || result.evidence_decision !== 'ALLOW'
      || result.evidence_authority !== 'unchanged'
      || result.evidence_decision_fingerprint !== result.decision_fingerprint
      || typeof result.evidence_fingerprint !== 'string'
      || result.public_import !== EXECUTION_ADMISSION_SUBPATH
      || result.authority !== 'unchanged'
      || result.network_access !== false
      || result.external_mutation !== false
    ) {
      fail('Execution Admission público no conservó contrato esperado.');
    }

    return Object.freeze(result as unknown as ConsumedAdmission);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const expectedVersion = await expectedPackageVersion();
  const verification = verifyReceipt(options, expectedVersion);
  const compatibility = await verifyCompatibility(options);
  const fixture = buildFixture();
  const consumed = await consumeVerifiedArtifact(options, fixture);

  process.stdout.write(JSON.stringify({
    version: 1,
    verified: verification.verified,
    installed_from_local_artifact: true,
    public_api_consumed: true,
    public_import: consumed.public_import,
    receipt_sha256: verification.receipt_sha256,
    artifact_sha256: verification.artifact_sha256,
    package: verification.package,
    compatibility_status: compatibility.status,
    compatibility_authority: compatibility.authority,
    compatibility_reasons: compatibility.reasons,
    compatibility_fingerprint: compatibility.fingerprint,
    decision: consumed.decision,
    decision_authority: consumed.decision_authority,
    decision_fingerprint: consumed.decision_fingerprint,
    evidence_decision: consumed.evidence_decision,
    evidence_authority: consumed.evidence_authority,
    evidence_decision_fingerprint: consumed.evidence_decision_fingerprint,
    evidence_fingerprint: consumed.evidence_fingerprint,
    scripts_disabled: true,
    registry_access: false,
    publish_attempted: false,
    authority: 'unchanged',
    execution: false,
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
