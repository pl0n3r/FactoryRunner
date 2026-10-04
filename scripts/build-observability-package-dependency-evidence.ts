import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  manifest: string;
  lockfile: string;
  output: string;
}>;

type PackageIdentity = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type RuntimeDependency = Readonly<{
  name: string;
  specifier: string;
  locked_version: string;
}>;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  throw new Error(message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 6) {
    fail(
      'Uso: build-observability-package-dependency-evidence.ts '
      + '--manifest <package.json> --lockfile <package-lock.json> --output <evidence.json>',
    );
  }

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--manifest', '--lockfile', '--output'].includes(key)
      || value === undefined
      || value.trim() === ''
      || values.has(key)
    ) {
      fail('Argumentos inválidos.');
    }
    values.set(key, value);
  }

  return {
    manifest: resolve(values.get('--manifest') as string),
    lockfile: resolve(values.get('--lockfile') as string),
    output: resolve(values.get('--output') as string),
  };
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ' inválido.');
  }
  return value as JsonObject;
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail(label + ' no contiene JSON válido.');
  }
}

function dependencyMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const object = asObject(value, label);
  const result: Record<string, string> = {};

  for (const name of Object.keys(object).sort(compareText)) {
    const specifier = object[name];
    if (!PACKAGE_NAME_RE.test(name) || typeof specifier !== 'string' || specifier.trim() === '') {
      fail(label + ' contiene una dependencia inválida.');
    }
    const normalized = specifier.trim();
    if (
      normalized.includes('://')
      || normalized.includes('\\')
      || normalized.startsWith('/')
      || normalized.startsWith('.')
      || normalized.includes(':')
    ) {
      fail(label + ' contiene un specifier no localmente verificable.');
    }
    result[name] = normalized;
  }

  return Object.freeze(result);
}

function ensureUnsupportedDependencyKindsAbsent(
  object: JsonObject,
  label: string,
): void {
  for (const key of [
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    if (object[key] !== undefined) {
      fail(label + ' usa una clase de dependencia no soportada: ' + key);
    }
  }
}

function packageManifest(input: unknown): {
  identity: PackageIdentity;
  runtimeDependencies: Readonly<Record<string, string>>;
} {
  const manifest = asObject(input, 'package.json empaquetado');

  if (
    typeof manifest.name !== 'string'
    || !manifest.name.startsWith('@pl0n3r/')
    || !PACKAGE_NAME_RE.test(manifest.name)
    || typeof manifest.version !== 'string'
    || !SEMVER_RE.test(manifest.version)
    || manifest.private !== true
    || manifest.type !== 'module'
  ) {
    fail('Identidad del package.json empaquetado inválida.');
  }

  if (manifest.devDependencies !== undefined) {
    fail('El package.json empaquetado no debe declarar devDependencies.');
  }
  ensureUnsupportedDependencyKindsAbsent(manifest, 'package.json empaquetado');

  return {
    identity: Object.freeze({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
    }),
    runtimeDependencies: dependencyMap(
      manifest.dependencies,
      'package.json empaquetado dependencies',
    ),
  };
}

function packageLock(
  input: unknown,
  identity: PackageIdentity,
  manifestDependencies: Readonly<Record<string, string>>,
): {
  lockfileVersion: 3;
  dependencies: readonly RuntimeDependency[];
} {
  const lock = asObject(input, 'package-lock.json');
  if (
    lock.lockfileVersion !== 3
    || typeof lock.name !== 'string'
    || lock.name !== identity.name
    || typeof lock.version !== 'string'
    || lock.version !== identity.version
  ) {
    fail('Identidad raíz de package-lock.json incoherente.');
  }

  const packages = asObject(lock.packages, 'package-lock.json packages');
  const root = asObject(packages[''], 'package-lock.json packages[""]');
  if (root.name !== identity.name || root.version !== identity.version) {
    fail('Entrada raíz de package-lock.json incoherente.');
  }

  ensureUnsupportedDependencyKindsAbsent(root, 'package-lock.json root');
  const rootDependencies = dependencyMap(
    root.dependencies,
    'package-lock.json root dependencies',
  );

  const manifestNames = Object.keys(manifestDependencies).sort(compareText);
  const lockNames = Object.keys(rootDependencies).sort(compareText);
  if (
    manifestNames.length !== lockNames.length
    || manifestNames.some((name, index) => name !== lockNames[index])
  ) {
    fail('Dependencias runtime del manifest y lockfile no coinciden.');
  }

  const dependencies: RuntimeDependency[] = [];
  for (const name of manifestNames) {
    if (manifestDependencies[name] !== rootDependencies[name]) {
      fail('Specifier runtime difiere entre manifest y lockfile: ' + name);
    }

    const entry = asObject(
      packages['node_modules/' + name],
      'Entrada lockfile de ' + name,
    );
    if (
      typeof entry.version !== 'string'
      || !SEMVER_RE.test(entry.version)
      || entry.link === true
      || entry.dev === true
    ) {
      fail('Entrada runtime bloqueada inválida: ' + name);
    }

    dependencies.push(Object.freeze({
      name,
      specifier: manifestDependencies[name],
      locked_version: entry.version,
    }));
  }

  return {
    lockfileVersion: 3,
    dependencies: Object.freeze(dependencies),
  };
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    const object = value as JsonObject;
    const result: JsonObject = {};
    for (const key of Object.keys(object).sort(compareText)) {
      result[key] = canonicalValue(object[key]);
    }
    return result;
  }
  fail('Valor no serializable.');
}

async function boundedRead(path: string, maximum: number, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum) {
    fail(label + ' excede límites locales.');
  }
  return await readFile(path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [manifestBody, lockBody] = await Promise.all([
    boundedRead(options.manifest, MAX_MANIFEST_BYTES, 'package.json empaquetado'),
    boundedRead(options.lockfile, MAX_LOCKFILE_BYTES, 'package-lock.json'),
  ]);

  const manifest = packageManifest(parseJson(manifestBody, 'package.json empaquetado'));
  const lock = packageLock(
    parseJson(lockBody, 'package-lock.json'),
    manifest.identity,
    manifest.runtimeDependencies,
  );

  const evidence = {
    schema_version: 1,
    package: manifest.identity,
    source: {
      manifest_sha256: sha256(manifestBody),
      lockfile_sha256: sha256(lockBody),
      lockfile_version: lock.lockfileVersion,
    },
    runtime_dependencies: lock.dependencies,
    network_access: false,
    external_mutation: false,
  };

  await writeFile(
    options.output,
    JSON.stringify(canonicalValue(evidence), null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx' },
  );
}

await main();
