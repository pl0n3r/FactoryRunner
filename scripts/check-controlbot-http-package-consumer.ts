import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  controlBotHttpPublicCompatibility,
  controlBotHttpPublicManifest,
  type ControlBotHttpPublicCompatibility,
} from '../src/controlbot-http-public.ts';

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
}>;

type Consumed = Readonly<{
  public_import: typeof PUBLIC_SUBPATH;
  compatibility_status: 'COMPATIBLE';
  protocol_path: '/v1/runner/poll';
  binding_authority: 'unchanged';
  ack_kind: 'ack';
  transport_mode: 'injected_test_only';
  response_status: number;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VERIFIER = resolve(ROOT, 'scripts', 'check-observability-package-release-receipt.ts');
const EXPECTED_PACKAGE = '@pl0n3r/factoryrunner';
const PUBLIC_SUBPATH = EXPECTED_PACKAGE + '/controlbot-http';
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
const MAX_LOCAL_BYTES = 64 * 1024;

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

async function localJson(path: string, label: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > MAX_LOCAL_BYTES
  ) {
    fail(label + ': archivo local inválido.');
  }

  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    fail(label + ': JSON inválido.');
  }
}

async function expectedVersion(): Promise<string> {
  const input = await localJson(resolve(ROOT, 'package.json'), 'package.json');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('package.json inválido.');
  }
  const version = (input as Record<string, unknown>).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('Versión local inválida.');
  }
  return version;
}

function verifyReceipt(options: Options, version: string): Verification {
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
  const packageValue = result.package;
  if (
    result.verified !== true
    || result.authority !== 'unchanged'
    || result.network_access !== false
    || result.external_mutation !== false
    || typeof result.receipt_sha256 !== 'string'
    || typeof result.artifact_sha256 !== 'string'
    || typeof packageValue !== 'object'
    || packageValue === null
    || Array.isArray(packageValue)
  ) {
    fail('Verifier no confirmó evidencia local esperada.');
  }

  const packageMetadata = packageValue as Record<string, unknown>;
  if (
    packageMetadata.name !== EXPECTED_PACKAGE
    || packageMetadata.version !== version
  ) {
    fail('Identidad exacta del paquete no coincide.');
  }

  return Object.freeze({
    verified: true,
    receipt_sha256: result.receipt_sha256,
    artifact_sha256: result.artifact_sha256,
    package: Object.freeze({ name: EXPECTED_PACKAGE, version }),
  });
}

async function verifyCompatibility(options: Options): Promise<ControlBotHttpPublicCompatibility> {
  const requirements = await localJson(options.requirements, 'requirements');
  const manifest = controlBotHttpPublicManifest();
  const compatibility = controlBotHttpPublicCompatibility(manifest, requirements);

  if (
    compatibility.status !== 'COMPATIBLE'
    || compatibility.authority !== 'unchanged'
    || compatibility.reasons.length !== 0
    || compatibility.execution !== false
    || compatibility.network_access !== false
    || compatibility.external_mutation !== false
    || compatibility.manifest_fingerprint !== manifest.fingerprint
  ) {
    fail('Compatibilidad pública ControlBot HTTP rechazada.');
  }
  return compatibility;
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

async function consumeArtifact(options: Options): Promise<Consumed> {
  const npmMetadata = await lstat(NPM_CLI);
  if (!npmMetadata.isFile() || npmMetadata.isSymbolicLink()) {
    fail('npm CLI canónico no disponible.');
  }

  const root = await mkdtemp(join(tmpdir(), 'factoryrunner-controlbot-http-consumer-'));
  try {
    const cache = join(root, 'npm-cache');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'factoryrunner-controlbot-http-consumer-fixture',
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

    const consumerPath = join(root, 'consumer.mjs');
    const source = [
      "import {",
      "  ControlBotHttpSessionClient,",
      "  assertFencedAck,",
      "  bindFencedExecution,",
      "  controlBotHttpPublicCompatibility,",
      "  controlBotHttpPublicManifest,",
      "  controlBotRunnerHttpRequest,",
      "} from '@pl0n3r/factoryrunner/controlbot-http';",
      "",
      "const manifest = controlBotHttpPublicManifest();",
      "const requirements = {",
      "  version: 1,",
      "  subpath: './controlbot-http',",
      "  protocol_version: 1,",
      "  fencing: 'required',",
      "  session_transport: 'injected_test_only',",
      "  authority: 'unchanged',",
      "  execution: false,",
      "  network_access: false,",
      "  external_mutation: false,",
      "  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({",
      "    export_name, contract_version, capability,",
      "  })),",
      "};",
      "const compatibility = controlBotHttpPublicCompatibility(manifest, requirements);",
      "if (compatibility.status !== 'COMPATIBLE' || compatibility.reasons.length !== 0) {",
      "  throw new Error('installed public contract incompatible');",
      "}",
      "",
      "const runnerId = '11111111-1111-7111-8111-111111111111';",
      "const orderId = '22222222-2222-7222-8222-222222222222';",
      "const attemptId = '33333333-3333-7333-8333-333333333333';",
      "const session = {",
      "  version: 1,",
      "  session_id: 'factoryrunner:session:424',",
      "  runner_id: runnerId,",
      "  generation: 7,",
      "  scope: 'controlbot:http:test',",
      "};",
      "const pollEnvelope = {",
      "  version: 1, method: 'POST', path: '/v1/runner/poll',",
      "  payload: {",
      "    version: 1, runner_id: runnerId,",
      "    session_id: session.session_id, generation: 7, requested_at: 1000,",
      "  },",
      "};",
      "const poll = controlBotRunnerHttpRequest(pollEnvelope);",
      "const controlBotOrder = {",
      "  version: 1, order_id: orderId, attempt_id: attemptId, generation: 7,",
      "  work_item_id: 'factoryrunner:work:424', runner_id: runnerId,",
      "  capability: 'git.head', attempt: 1, scope: session.scope,",
      "  issued_at: 1001, expires_at: 1100,",
      "  instruction_ref: 'controlbot:instruction:factoryrunner-424',",
      "};",
      "const internalOrder = {",
      "  version: 1, order_id: orderId, work_item_id: 'factoryrunner:work:424',",
      "  runner_id: runnerId, capability: 'git.head', attempt: 1,",
      "  issued_at: 1001, expires_at: 1100,",
      "  instruction_ref: 'controlbot:instruction:factoryrunner-424',",
      "};",
      "const binding = bindFencedExecution(session, pollEnvelope, controlBotOrder, internalOrder);",
      "const ackPayload = {",
      "  version: 1, order_id: orderId, attempt_id: attemptId,",
      "  runner_id: runnerId, generation: 7, acknowledged_at: 1002,",
      "};",
      "const ackEnvelope = { version: 1, method: 'POST', path: '/v1/runner/ack', payload: ackPayload };",
      "const fencedAck = assertFencedAck(binding, ackEnvelope);",
      "",
      "const client = new ControlBotHttpSessionClient({",
      "  enabled: true,",
      "  test_mode: true,",
      "  test_transport: async (request) => ({",
      "    version: 1,",
      "    request_fingerprint: request.request_fingerprint,",
      "    status: 200,",
      "    body: { accepted: true },",
      "  }),",
      "});",
      "const response = await client.ack(binding, ackPayload);",
      "const status = client.status();",
      "",
      "process.stdout.write(JSON.stringify({",
      "  public_import: '@pl0n3r/factoryrunner/controlbot-http',",
      "  compatibility_status: compatibility.status,",
      "  protocol_path: poll.path,",
      "  binding_authority: binding.authority,",
      "  ack_kind: fencedAck.kind,",
      "  transport_mode: status.transport_mode,",
      "  response_status: response.status,",
      "  authority: response.authority,",
      "  execution: response.execution,",
      "  network_access: response.network_access,",
      "  external_mutation: response.external_mutation,",
      "}));",
      "",
    ].join('\n');

    await writeFile(consumerPath, source, 'utf8');
    const consumed = spawnSync(process.execPath, [consumerPath], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    });
    if (consumed.error !== undefined || consumed.status !== 0) {
      fail('Consumo de ControlBot HTTP rechazado.');
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
      result.public_import !== PUBLIC_SUBPATH
      || result.compatibility_status !== 'COMPATIBLE'
      || result.protocol_path !== '/v1/runner/poll'
      || result.binding_authority !== 'unchanged'
      || result.ack_kind !== 'ack'
      || result.transport_mode !== 'injected_test_only'
      || result.response_status !== 200
      || result.authority !== 'unchanged'
      || result.execution !== false
      || result.network_access !== false
      || result.external_mutation !== false
    ) {
      fail('Consumer ControlBot HTTP no conservó el contrato esperado.');
    }

    return Object.freeze(result as unknown as Consumed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const version = await expectedVersion();
  const verification = verifyReceipt(options, version);
  const compatibility = await verifyCompatibility(options);
  const consumed = await consumeArtifact(options);

  process.stdout.write(JSON.stringify({
    version: 1,
    verified: verification.verified,
    installed_from_local_artifact: true,
    public_api_consumed: true,
    public_import: consumed.public_import,
    package: verification.package,
    receipt_sha256: verification.receipt_sha256,
    artifact_sha256: verification.artifact_sha256,
    compatibility_status: compatibility.status,
    compatibility_authority: compatibility.authority,
    compatibility_reasons: compatibility.reasons,
    protocol_path: consumed.protocol_path,
    binding_authority: consumed.binding_authority,
    ack_kind: consumed.ack_kind,
    transport_mode: consumed.transport_mode,
    response_status: consumed.response_status,
    scripts_disabled: true,
    registry_access: false,
    publish_attempted: false,
    authority: consumed.authority,
    execution: false,
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
