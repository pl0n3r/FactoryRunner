import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  controlBotHttpPublicCompatibility,
  controlBotHttpPublicManifest,
} from '../src/controlbot-http-public.ts';

type Inputs = Readonly<Record<
  'receipt' | 'artifact' | 'provenance' | 'dependencies' | 'preflight' | 'requirements',
  string
>>;

type JsonMap = Record<string, unknown>;
type CompatibilityBinding = Readonly<{
  fingerprint: string;
  manifest_fingerprint: string;
  requirements_json: string;
}>;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const VERIFY_RECEIPT = resolve(ROOT, 'scripts', 'check-observability-package-release-receipt.ts');
const PACKAGE_ID = '@pl0n3r/factoryrunner';
const PUBLIC_IMPORT = PACKAGE_ID + '/controlbot-http';
const NPM_CLI = resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const FLAGS = Object.freeze([
  'receipt', 'artifact', 'provenance', 'dependencies', 'preflight', 'requirements',
] as const);
const BUFFER_LIMIT = 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function inputs(argv: readonly string[]): Inputs {
  if (argv.length !== FLAGS.length * 2) fail('Argumentos inválidos.');
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const rawFlag = argv[index] ?? '';
    const value = argv[index + 1] ?? '';
    const key = rawFlag.startsWith('--') ? rawFlag.slice(2) : '';
    if (
      !FLAGS.includes(key as typeof FLAGS[number])
      || value.trim() === ''
      || key in values
    ) fail('Argumentos inválidos.');
    values[key] = resolve(value);
  }
  if (FLAGS.some((key) => !(key in values))) fail('Falta input requerido.');
  return Object.freeze(values as Inputs);
}

function commandJson(args: readonly string[], label: string, cwd = ROOT): JsonMap {
  const completed = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: BUFFER_LIMIT,
  });
  if (completed.error !== undefined || completed.status !== 0) fail(label + ' rechazado.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(completed.stdout) as unknown;
  } catch {
    fail(label + ' produjo JSON inválido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(label + ' produjo estructura inválida.');
  }
  return parsed as JsonMap;
}

function verifiedReceipt(value: Inputs): Readonly<{
  receipt_sha256: string;
  artifact_sha256: string;
  package_version: string;
}> {
  const report = commandJson([
    '--experimental-strip-types',
    VERIFY_RECEIPT,
    '--receipt', value.receipt,
    '--artifact', value.artifact,
    '--provenance', value.provenance,
    '--dependencies', value.dependencies,
    '--preflight', value.preflight,
  ], 'Release receipt');

  const packageValue = report.package;
  if (typeof packageValue !== 'object' || packageValue === null || Array.isArray(packageValue)) {
    fail('Package verificado inválido.');
  }
  const metadata = packageValue as JsonMap;
  if (
    report.verified !== true
    || report.authority !== 'unchanged'
    || report.network_access !== false
    || report.external_mutation !== false
    || metadata.name !== PACKAGE_ID
    || typeof metadata.version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(metadata.version)
    || typeof report.receipt_sha256 !== 'string'
    || typeof report.artifact_sha256 !== 'string'
  ) fail('Release receipt no conserva identidad local esperada.');

  return Object.freeze({
    receipt_sha256: report.receipt_sha256,
    artifact_sha256: report.artifact_sha256,
    package_version: metadata.version,
  });
}

async function compatibleRequirements(path: string): Promise<CompatibilityBinding> {
  let requirementInput: unknown;
  try {
    requirementInput = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    fail('Requirements inválidos.');
  }

  const manifest = controlBotHttpPublicManifest();
  const report = controlBotHttpPublicCompatibility(manifest, requirementInput);
  if (
    report.status !== 'COMPATIBLE'
    || report.reasons.length !== 0
    || report.authority !== 'unchanged'
    || report.execution !== false
    || report.network_access !== false
    || report.external_mutation !== false
    || report.manifest_fingerprint !== manifest.fingerprint
  ) fail('Compatibilidad pública ControlBot HTTP rechazada.');

  const requirementsJson = JSON.stringify(requirementInput);
  if (requirementsJson === undefined) fail('Requirements no serializables.');

  return Object.freeze({
    fingerprint: report.fingerprint,
    manifest_fingerprint: manifest.fingerprint,
    requirements_json: requirementsJson,
  });
}

function npmEnv(cache: string): NodeJS.ProcessEnv {
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

function consumerSource(binding: CompatibilityBinding): string {
  const expectedManifestFingerprint = JSON.stringify(binding.manifest_fingerprint);
  return String.raw`
import {
  ControlBotHttpSessionClient,
  bindFencedExecution,
  controlBotHttpPublicCompatibility,
  controlBotHttpPublicManifest,
  controlBotRunnerHttpRequest,
} from '@pl0n3r/factoryrunner/controlbot-http';

const externalRequirement = ${binding.requirements_json};
const expectedManifestFingerprint = ${expectedManifestFingerprint};
const manifest = controlBotHttpPublicManifest();
const compatibility = controlBotHttpPublicCompatibility(manifest, externalRequirement);
if (
  compatibility.status !== 'COMPATIBLE'
  || compatibility.reasons.length !== 0
  || compatibility.manifest_fingerprint !== expectedManifestFingerprint
  || manifest.fingerprint !== expectedManifestFingerprint
) {
  throw new Error('installed contract incompatible');
}

const runner = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const attemptId = '33333333-3333-7333-8333-333333333333';
const session = {
  version: 1, session_id: 'factoryrunner:session:424', runner_id: runner,
  generation: 7, scope: 'controlbot:http:test',
};
const pollEnvelope = {
  version: 1, method: 'POST', path: '/v1/runner/poll',
  payload: {
    version: 1, runner_id: runner, session_id: session.session_id,
    generation: 7, requested_at: 1000,
  },
};
const poll = controlBotRunnerHttpRequest(pollEnvelope);
const order = {
  version: 1, order_id: orderId, attempt_id: attemptId, generation: 7,
  work_item_id: 'factoryrunner:work:424', runner_id: runner,
  capability: 'git.head', attempt: 1, scope: session.scope,
  issued_at: 1001, expires_at: 1100,
  instruction_ref: 'controlbot:instruction:factoryrunner-424',
};
const internalOrder = {
  version: 1, order_id: orderId, work_item_id: order.work_item_id,
  runner_id: runner, capability: order.capability, attempt: 1,
  issued_at: order.issued_at, expires_at: order.expires_at,
  instruction_ref: order.instruction_ref,
};
const binding = bindFencedExecution(session, pollEnvelope, order, internalOrder);
const ack = {
  version: 1, order_id: orderId, attempt_id: attemptId,
  runner_id: runner, generation: 7, acknowledged_at: 1002,
};

const client = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: { accepted: true },
  }),
});
const response = await client.ack(binding, ack);
const status = client.status();

process.stdout.write(JSON.stringify({
  public_import: '@pl0n3r/factoryrunner/controlbot-http',
  compatibility_status: compatibility.status,
  installed_manifest_fingerprint: compatibility.manifest_fingerprint,
  installed_compatibility_fingerprint: compatibility.fingerprint,
  protocol_path: poll.path,
  binding_authority: binding.authority,
  transport_mode: status.transport_mode,
  response_status: response.status,
  authority: response.authority,
  execution: response.execution,
  network_access: response.network_access,
  external_mutation: response.external_mutation,
}));
`;
}

async function consume(artifact: string, binding: CompatibilityBinding): Promise<JsonMap> {
  const root = await mkdtemp(join(tmpdir(), 'factoryrunner-cb-http-'));
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }) + '\n',
      'utf8',
    );
    const install = spawnSync(
      process.execPath,
      [
        NPM_CLI, 'install', '--offline', '--ignore-scripts', '--no-audit',
        '--no-fund', '--package-lock=false', '--save-exact', artifact,
      ],
      {
        cwd: root,
        env: npmEnv(join(root, 'npm-cache')),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: BUFFER_LIMIT,
      },
    );
    if (install.error !== undefined || install.status !== 0) fail('Instalación local offline rechazada.');

    const consumer = join(root, 'consumer.mjs');
    await writeFile(consumer, consumerSource(binding), 'utf8');
    return commandJson([consumer], 'Consumer ControlBot HTTP', root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertConsumed(result: JsonMap, binding: CompatibilityBinding): void {
  if (
    result.public_import !== PUBLIC_IMPORT
    || result.compatibility_status !== 'COMPATIBLE'
    || result.installed_manifest_fingerprint !== binding.manifest_fingerprint
    || result.installed_compatibility_fingerprint !== binding.fingerprint
    || result.protocol_path !== '/v1/runner/poll'
    || result.binding_authority !== 'unchanged'
    || result.transport_mode !== 'injected_test_only'
    || result.response_status !== 200
    || result.authority !== 'unchanged'
    || result.execution !== false
    || result.network_access !== false
    || result.external_mutation !== false
  ) fail('Consumer ControlBot HTTP no conservó el contrato esperado.');
}

async function main(): Promise<void> {
  const value = inputs(process.argv.slice(2));
  const receipt = verifiedReceipt(value);
  const compatibilityBinding = await compatibleRequirements(value.requirements);
  const consumed = await consume(value.artifact, compatibilityBinding);
  assertConsumed(consumed, compatibilityBinding);

  process.stdout.write(JSON.stringify({
    version: 1,
    verified: true,
    installed_from_local_artifact: true,
    public_api_consumed: true,
    public_import: consumed.public_import,
    package_version: receipt.package_version,
    receipt_sha256: receipt.receipt_sha256,
    artifact_sha256: receipt.artifact_sha256,
    compatibility_status: consumed.compatibility_status,
    compatibility_fingerprint: compatibilityBinding.fingerprint,
    manifest_fingerprint: compatibilityBinding.manifest_fingerprint,
    installed_manifest_fingerprint: consumed.installed_manifest_fingerprint,
    installed_compatibility_fingerprint: consumed.installed_compatibility_fingerprint,
    protocol_path: consumed.protocol_path,
    binding_authority: consumed.binding_authority,
    transport_mode: consumed.transport_mode,
    response_status: consumed.response_status,
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
