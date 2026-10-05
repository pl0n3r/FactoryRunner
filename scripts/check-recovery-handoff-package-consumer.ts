import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BUILDER = resolve(ROOT, 'scripts', 'build-observability-package.ts');
const PACKAGE_NAME = '@pl0n3r/factoryrunner';
const PUBLIC_SUBPATH = PACKAGE_NAME + '/recovery-handoff';
const NPM_CLI = resolve(
  dirname(process.execPath),
  '..',
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);

type SmokeResult = Readonly<{
  version: 1;
  installed_from_local_artifact: true;
  imported_subpath: typeof PUBLIC_SUBPATH;
  manifest_status: 'READY';
  manifest_authority: 'unchanged';
  manifest_execution: false;
  manifest_network_access: false;
  manifest_external_mutation: false;
  compatibility_status: 'COMPATIBLE';
  compatibility_authority: 'unchanged';
  compatibility_reasons: readonly [];
  compatibility_execution: false;
  compatibility_network_access: false;
  compatibility_external_mutation: false;
  registry_access: false;
  publish_attempted: false;
  authority: 'unchanged';
  network_access: false;
  external_mutation: false;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function runNode(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const completed = spawnSync(process.execPath, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (completed.error !== undefined || completed.status !== 0) {
    fail('Smoke local rechazado.');
  }
  return completed.stdout;
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

async function localTarball(root: string): Promise<string> {
  const stage = join(root, 'stage');
  runNode(
    ['--experimental-strip-types', BUILDER, '--output', stage],
    ROOT,
  );

  const staged = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')) as unknown;
  if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) {
    fail('Manifest staged inválido.');
  }
  const exportsValue = (staged as Record<string, unknown>).exports;
  if (
    typeof exportsValue !== 'object'
    || exportsValue === null
    || Array.isArray(exportsValue)
    || (exportsValue as Record<string, unknown>)['./recovery-handoff']
      !== './src/execution-recovery-handoff-public.js'
  ) {
    fail('Subpath Recovery Handoff ausente en artefacto local.');
  }

  const packDirectory = join(root, 'pack');
  await mkdir(packDirectory);
  const packed = runNode(
    [
      NPM_CLI,
      'pack',
      '--json',
      '--offline',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
      '.',
    ],
    stage,
    npmEnvironment(join(root, 'pack-cache')),
  );

  let payload: unknown;
  try {
    payload = JSON.parse(packed) as unknown;
  } catch {
    fail('npm pack produjo salida inválida.');
  }
  if (!Array.isArray(payload) || payload.length !== 1) {
    fail('npm pack no produjo un único artefacto.');
  }
  const filename = (payload[0] as Record<string, unknown>).filename;
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
    fail('Tarball local inválido.');
  }
  const tarball = join(packDirectory, filename);
  const metadata = await lstat(tarball);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('Tarball local no es archivo regular.');
  }
  return tarball;
}

async function installLocalArtifact(root: string, tarball: string): Promise<string> {
  const consumer = join(root, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'factoryrunner-recovery-handoff-consumer-fixture',
      private: true,
      type: 'module',
    }) + '\n',
    'utf8',
  );

  runNode(
    [
      NPM_CLI,
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--save-exact',
      tarball,
    ],
    consumer,
    npmEnvironment(join(root, 'install-cache')),
  );
  return consumer;
}

async function consumePublicSubpath(consumer: string): Promise<SmokeResult> {
  const consumerScript = join(consumer, 'consumer.mjs');
  await writeFile(
    consumerScript,
    `import {
  executionRecoveryHandoffPublicCompatibility,
  executionRecoveryHandoffPublicManifest,
} from '@pl0n3r/factoryrunner/recovery-handoff';

const manifest = executionRecoveryHandoffPublicManifest();
const compatibility = executionRecoveryHandoffPublicCompatibility(
  manifest,
  manifest.exports.map((entry) => ({
    export_name: entry.export_name,
    contract_version: entry.contract_version,
  })),
);

process.stdout.write(JSON.stringify({
  version: 1,
  installed_from_local_artifact: true,
  imported_subpath: '@pl0n3r/factoryrunner/recovery-handoff',
  manifest_status: 'READY',
  manifest_authority: manifest.authority,
  manifest_execution: manifest.execution,
  manifest_network_access: manifest.network_access,
  manifest_external_mutation: manifest.external_mutation,
  compatibility_status: compatibility.status,
  compatibility_authority: compatibility.authority,
  compatibility_reasons: compatibility.reasons,
  compatibility_execution: compatibility.execution,
  compatibility_network_access: compatibility.network_access,
  compatibility_external_mutation: compatibility.external_mutation,
  registry_access: false,
  publish_attempted: false,
  authority: 'unchanged',
  network_access: false,
  external_mutation: false,
}));
`,
    'utf8',
  );

  const output = runNode([consumerScript], consumer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    fail('Consumidor Recovery Handoff produjo salida inválida.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('Consumidor Recovery Handoff produjo salida inválida.');
  }
  const result = parsed as Record<string, unknown>;
  if (
    result.version !== 1
    || result.installed_from_local_artifact !== true
    || result.imported_subpath !== PUBLIC_SUBPATH
    || result.manifest_status !== 'READY'
    || result.manifest_authority !== 'unchanged'
    || result.manifest_execution !== false
    || result.manifest_network_access !== false
    || result.manifest_external_mutation !== false
    || result.compatibility_status !== 'COMPATIBLE'
    || result.compatibility_authority !== 'unchanged'
    || !Array.isArray(result.compatibility_reasons)
    || result.compatibility_reasons.length !== 0
    || result.compatibility_execution !== false
    || result.compatibility_network_access !== false
    || result.compatibility_external_mutation !== false
    || result.registry_access !== false
    || result.publish_attempted !== false
    || result.authority !== 'unchanged'
    || result.network_access !== false
    || result.external_mutation !== false
  ) {
    fail('Recovery Handoff público no conservó contrato fail-closed.');
  }
  return Object.freeze(result as unknown as SmokeResult);
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) fail('Este smoke no acepta argumentos.');
  const npmMetadata = await lstat(NPM_CLI);
  if (!npmMetadata.isFile()) fail('npm CLI canónico no disponible.');

  const root = await mkdtemp(join(tmpdir(), 'factoryrunner-recovery-handoff-consumer-'));
  try {
    const tarball = await localTarball(root);
    const consumer = await installLocalArtifact(root, tarball);
    const result = await consumePublicSubpath(consumer);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
