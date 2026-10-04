import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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

const LIMITS = Object.freeze({
  receipt: 4096,
  artifact: 32 * 1024 * 1024,
  evidence: 4 * 1024 * 1024,
  preflight: 1024 * 1024,
});

function fail(message: string): never {
  throw new Error(message);
}

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
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
  if (flags.some((flag) => !values.has(flag))) fail('Falta input requerido.');

  return Object.freeze({
    receipt: resolve(values.get('--receipt') as string),
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
    preflight: resolve(values.get('--preflight') as string),
  });
}

async function localBytes(
  path: string,
  maximum: number,
  label: string,
): Promise<Buffer> {
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

async function regenerateExpected(options: Options): Promise<Buffer> {
  const builder = resolve(
    process.cwd(),
    'scripts',
    'create-observability-package-release-receipt.ts',
  );
  const builderMetadata = await lstat(builder);
  if (builderMetadata.isSymbolicLink() || !builderMetadata.isFile()) {
    fail('Builder canónico inválido.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'factoryrunner-receipt-verify-'));
  const output = join(directory, 'expected.json');
  try {
    const completed = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        builder,
        '--artifact',
        options.artifact,
        '--provenance',
        options.provenance,
        '--dependencies',
        options.dependencies,
        '--preflight',
        options.preflight,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: LIMITS.preflight,
      },
    );
    if (completed.error !== undefined || completed.status !== 0) {
      fail('No fue posible regenerar el receipt canónico.');
    }
    return await localBytes(output, LIMITS.receipt, 'receipt esperado');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [receiptBody, artifactBody] = await Promise.all([
    localBytes(options.receipt, LIMITS.receipt, 'receipt'),
    localBytes(options.artifact, LIMITS.artifact, 'artifact'),
    localBytes(options.provenance, LIMITS.evidence, 'provenance'),
    localBytes(options.dependencies, LIMITS.evidence, 'dependencies'),
    localBytes(options.preflight, LIMITS.preflight, 'preflight'),
  ]);

  const expected = await regenerateExpected(options);
  if (!receiptBody.equals(expected)) {
    fail('Receipt no coincide byte a byte con la regeneración canónica.');
  }

  const payload = JSON.parse(expected.toString('utf8')) as {
    package: unknown;
    artifact: { sha256: string };
  };
  if (payload.artifact.sha256 !== sha256(artifactBody)) {
    fail('Artifact no coincide con el receipt verificado.');
  }

  process.stdout.write(JSON.stringify({
    verified: true,
    receipt_sha256: sha256(receiptBody),
    artifact_sha256: payload.artifact.sha256,
    package: payload.package,
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
