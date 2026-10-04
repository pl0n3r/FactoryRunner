import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

type Options = Readonly<{
  receipt: string;
  artifact: string;
  provenance: string;
  dependencies: string;
  preflight: string;
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

const VERIFIER = resolve(
  process.cwd(),
  'scripts',
  'check-observability-package-release-receipt.ts',
);

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

  return Object.freeze({
    receipt: resolve(values.get('--receipt') as string),
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
    preflight: resolve(values.get('--preflight') as string),
  });
}

function verifyReceipt(options: Options): Verification {
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
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (completed.error !== undefined || completed.status !== 0) {
    fail('Release receipt no verificado; instalación bloqueada.');
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
    fail('Verifier no confirmó autoridad local esperada.');
  }
  const packageValue = result.package as Record<string, unknown>;
  if (
    typeof packageValue.name !== 'string'
    || typeof packageValue.version !== 'string'
  ) {
    fail('Verifier no confirmó identidad del paquete.');
  }

  return Object.freeze({
    verified: true,
    receipt_sha256: result.receipt_sha256,
    artifact_sha256: result.artifact_sha256,
    package: Object.freeze({
      name: packageValue.name,
      version: packageValue.version,
    }),
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  });
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
  verification: Verification,
): Promise<Readonly<{ packet_status: string; packet_authority: string }>> {
  const directory = await mkdtemp(join(tmpdir(), 'factoryrunner-verified-consumer-'));
  try {
    const consumer = join(directory, 'consumer');
    const cache = join(directory, 'npm-cache');
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'factoryrunner-verified-consumer-fixture',
        private: true,
        type: 'module',
      }) + '\n',
      'utf8',
    );

    const install = spawnSync(
      'npm',
      [
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
        cwd: directory,
        env: npmEnvironment(cache),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (install.error !== undefined || install.status !== 0) {
      fail('Instalación local offline rechazada.');
    }

    const script = join(directory, 'consumer.mjs');
    await writeFile(script, `import { createHash } from 'node:crypto';
import { browserRemoteObservabilityPublicPacket } from '${verification.package.name}';

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
      ordered[key] = canonicalValue(value[key]);
    }
    return ordered;
  }
  throw new TypeError('Valor no serializable.');
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value)), 'utf8').digest('hex');
}

const core = Object.freeze({
  version: 1,
  authority: 'unchanged',
  status: 'READY',
  doctor_fingerprint: 'a'.repeat(64),
  health_fingerprint: 'b'.repeat(64),
  metrics_fingerprint: 'c'.repeat(64),
  snapshot_fingerprint: 'd'.repeat(64),
  readiness_fingerprint: 'e'.repeat(64),
  network_access: false,
  external_mutation: false,
});
const health = Object.freeze({ ...core, fingerprint: fingerprint(core) });
const packet = browserRemoteObservabilityPublicPacket(health);
process.stdout.write(JSON.stringify({
  packet_status: packet.status,
  packet_authority: packet.authority,
  packet_network_access: packet.network_access,
  packet_external_mutation: packet.external_mutation,
}));
`, 'utf8');

    const consumed = spawnSync('node', [script], {
      cwd: consumer === directory ? consumer : directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (consumed.error !== undefined || consumed.status !== 0) {
      fail('Consumo de API pública rechazado.');
    }

    let result: unknown;
    try {
      result = JSON.parse(consumed.stdout) as unknown;
    } catch {
      fail('Consumidor produjo salida inválida.');
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      fail('Consumidor produjo salida inválida.');
    }
    const packet = result as Record<string, unknown>;
    if (
      packet.packet_status !== 'READY'
      || packet.packet_authority !== 'unchanged'
      || packet.packet_network_access !== false
      || packet.packet_external_mutation !== false
    ) {
      fail('API pública no conservó autoridad local esperada.');
    }
    return Object.freeze({
      packet_status: 'READY',
      packet_authority: 'unchanged',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const verification = verifyReceipt(options);
  const consumed = await consumeVerifiedArtifact(options, verification);
  process.stdout.write(JSON.stringify({
    verified: true,
    installed_from_local_artifact: true,
    public_api_consumed: true,
    receipt_sha256: verification.receipt_sha256,
    artifact_sha256: verification.artifact_sha256,
    package: verification.package,
    packet_status: consumed.packet_status,
    packet_authority: consumed.packet_authority,
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
