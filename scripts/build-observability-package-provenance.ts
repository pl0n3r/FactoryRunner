import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, posix } from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';

type PackageMetadata = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
  exports: Readonly<Record<string, string>>;
}>;

type Options = Readonly<{
  tarball: string;
  stage: string;
  output: string;
}>;

type ArchiveFile = Readonly<{
  path: string;
  body: Buffer;
}>;

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new Error(message);
}

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 6) {
    fail(
      'Uso: build-observability-package-provenance.ts '
      + '--tarball <archivo.tgz> --stage <directorio> --output <manifest.json>',
    );
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--tarball', '--stage', '--output'].includes(key)
      || value === undefined
      || value.trim() === ''
      || parsed.has(key)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(key, value);
  }
  for (const key of ['--tarball', '--stage', '--output']) {
    if (!parsed.has(key)) fail('Falta argumento requerido: ' + key);
  }
  return {
    tarball: resolve(parsed.get('--tarball') as string),
    stage: resolve(parsed.get('--stage') as string),
    output: resolve(parsed.get('--output') as string),
  };
}

function sha256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function cString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number): number {
  const raw = cString(block, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) fail('Header tar inválido.');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('Tamaño tar inválido.');
  return value;
}

function canonicalArchivePath(raw: string): string {
  if (!raw.startsWith('package/')) fail('Entrada tar fuera de package/.');
  const path = raw.slice('package/'.length);
  if (
    path === ''
    || path.includes('\\')
    || path.startsWith('/')
    || posix.normalize(path) !== path
    || path.split('/').some((part) => part === '' || part === '..' || part === '.')
  ) {
    fail('Ruta no canónica en tarball.');
  }
  return path;
}

function parseTarball(compressed: Buffer): Map<string, Buffer> {
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed);
  } catch {
    fail('Tarball gzip inválido.');
  }

  const files = new Map<string, Buffer>();
  let offset = 0;
  let sawTerminator = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const allZero = header.every((byte) => byte === 0);
    if (allZero) {
      sawTerminator = true;
      break;
    }

    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const rawPath = prefix === '' ? name : prefix + '/' + name;
    const size = octal(header, 124, 12);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) fail('Tarball truncado.');

    if (typeFlag === '0') {
      const path = canonicalArchivePath(rawPath);
      if (files.has(path)) fail('Archivo duplicado en tarball.');
      files.set(path, Buffer.from(archive.subarray(dataStart, dataEnd)));
    } else if (typeFlag !== '5' && typeFlag !== 'x' && typeFlag !== 'g') {
      fail('Tipo de entrada tar no permitido.');
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!sawTerminator || files.size === 0) fail('Tarball sin terminador o sin archivos.');
  return files;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ' inválido.');
  }
  return value as Record<string, unknown>;
}

function validateExports(value: unknown): Readonly<Record<string, string>> {
  const exportsValue = asObject(value, 'exports');
  const entries = Object.entries(exportsValue);
  if (
    entries.length === 0
    || entries.some(([key, target]) => (
      key.trim() === ''
      || typeof target !== 'string'
      || !target.startsWith('./')
      || target.includes('://')
    ))
  ) {
    fail('exports inválido.');
  }
  const ordered: Record<string, string> = {};
  for (const [key, target] of entries.sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    ordered[key] = target as string;
  }
  return Object.freeze(ordered);
}

function validatePackage(input: unknown): {
  metadata: PackageMetadata;
  allowlist: readonly string[];
} {
  const manifest = asObject(input, 'package.json');
  if (
    typeof manifest.name !== 'string'
    || !manifest.name.startsWith('@pl0n3r/')
    || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || manifest.private !== true
    || manifest.type !== 'module'
  ) {
    fail('Metadata mínima de paquete inválida.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('Allowlist empaquetada inválida.');
  }

  const allowlist = manifest.files.map((value) => {
    if (
      typeof value !== 'string'
      || value === ''
      || value.startsWith('/')
      || value.includes('\\')
      || value.includes('*')
      || value.includes('?')
      || posix.normalize(value) !== value
      || value.split('/').some((part) => part === '' || part === '..' || part === '.')
    ) {
      fail('Ruta inválida en allowlist.');
    }
    return value;
  });
  if (new Set(allowlist).size !== allowlist.length) fail('Allowlist duplicada.');
  const sorted = [...allowlist].sort((a, b) => a.localeCompare(b, 'en'));
  if (allowlist.some((value, index) => value !== sorted[index])) {
    fail('Allowlist debe estar ordenada.');
  }

  return {
    metadata: Object.freeze({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
      exports: validateExports(manifest.exports),
    }),
    allowlist: Object.freeze(allowlist),
  };
}

function toPosixRelative(root: string, path: string): string {
  const local = relative(root, path);
  if (local === '' || local.startsWith('..') || isAbsolute(local)) {
    fail('Ruta fuera del staging.');
  }
  return local.split(sep).join('/');
}

async function collectStageFiles(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail('Symlink no permitido en staging.');
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) fail('Tipo de archivo no permitido en staging.');
      const local = toPosixRelative(root, absolute);
      if (result.has(local)) fail('Archivo duplicado en staging.');
      result.set(local, await readFile(absolute));
    }
  }

  await walk(root);
  return result;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
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
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b, 'en'))) {
      result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  fail('Valor no serializable.');
}

function parseJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    fail(label + ' no contiene JSON válido.');
  }
}

function validateCoherence(
  staged: Map<string, Buffer>,
  archived: Map<string, Buffer>,
  allowlist: readonly string[],
  stagedPackage: unknown,
): void {
  const expected = ['README.md', 'package.json', ...allowlist]
    .sort((a, b) => a.localeCompare(b, 'en'));
  const stagedPaths = [...staged.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const archivedPaths = [...archived.keys()].sort((a, b) => a.localeCompare(b, 'en'));

  if (!equalJson(stagedPaths, expected)) fail('File list del staging no coincide con allowlist.');
  if (!equalJson(archivedPaths, expected)) fail('File list del tarball no coincide con allowlist.');

  const packedPackageBody = archived.get('package.json');
  if (packedPackageBody === undefined) fail('Falta package.json en tarball.');
  const packedPackage = parseJson(packedPackageBody, 'package.json empaquetado');
  const stagedValidated = validatePackage(stagedPackage);
  const packedValidated = validatePackage(packedPackage);
  if (
    !equalJson(stagedValidated.metadata, packedValidated.metadata)
    || !equalJson(stagedValidated.allowlist, packedValidated.allowlist)
  ) {
    fail('Metadata package.json del tarball no coincide con staging.');
  }

  for (const path of expected) {
    if (path === 'package.json') continue;
    const stagedBody = staged.get(path);
    const archivedBody = archived.get(path);
    if (stagedBody === undefined || archivedBody === undefined) {
      fail('Archivo requerido ausente.');
    }
    if (sha256(stagedBody) !== sha256(archivedBody)) {
      fail('Contenido del tarball no coincide con staging: ' + path);
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const tarballStat = await stat(options.tarball);
  if (!tarballStat.isFile() || tarballStat.size <= 0 || tarballStat.size > MAX_TARBALL_BYTES) {
    fail('Tarball local inválido.');
  }
  const stageStat = await stat(options.stage);
  if (!stageStat.isDirectory()) fail('Staging local inválido.');

  const tarball = await readFile(options.tarball);
  const archived = parseTarball(tarball);
  const staged = await collectStageFiles(options.stage);
  const stagedPackageBody = staged.get('package.json');
  if (stagedPackageBody === undefined) fail('Falta package.json en staging.');
  const stagedPackage = parseJson(stagedPackageBody, 'package.json de staging');
  const validated = validatePackage(stagedPackage);
  validateCoherence(staged, archived, validated.allowlist, stagedPackage);

  const files = [...archived.entries()]
    .map(([path, body]) => Object.freeze({
      path,
      sha256: sha256(body),
      size: body.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const manifest = {
    schema_version: 1,
    artifact: {
      filename: basename(options.tarball),
      sha256: sha256(tarball),
      size: tarball.length,
    },
    package: validated.metadata,
    allowlist: validated.allowlist,
    files,
    network_access: false,
    external_mutation: false,
  };

  const serialized = JSON.stringify(canonicalValue(manifest), null, 2) + '\n';
  if (!SHA256_RE.test(manifest.artifact.sha256)) fail('SHA-256 inválido.');
  await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'wx' });
}

await main();
