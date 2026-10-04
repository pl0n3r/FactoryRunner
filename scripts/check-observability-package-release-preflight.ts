import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, posix, resolve } from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';

type Obj = Record<string, unknown>;
type PackageCore = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;
type LocalFile = Readonly<{ path: string; sha256: string; size: number }>;

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({ artifact: 32 * 1024 * 1024, archive: 16 * 1024 * 1024, evidence: 4 * 1024 * 1024 });

function reject(message: string): never {
  throw new Error(message);
}

function shape(value: unknown, label: string, expected: readonly string[]): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(label + ': objeto requerido.');
  }
  const object = value as Obj;
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    reject(label + ': schema desconocido o incompleto.');
  }
  return object;
}

function digest(body: Uint8Array): string {
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
  if (!/^[0-7]+$/.test(raw)) reject('Header tar inválido.');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) reject('Tamaño tar inválido.');
  return value;
}

function validateTarHeaderChecksum(header: Buffer): void {
  const expected = octal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) reject('Checksum tar inválido.');
}

function canonicalArchivePath(raw: string): string {
  if (!raw.startsWith('package/')) reject('Entrada tar fuera de package/.');
  const path = raw.slice('package/'.length);
  if (
    path === ''
    || path.includes('\\')
    || path.startsWith('/')
    || posix.normalize(path) !== path
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    reject('Ruta no canónica en tarball.');
  }
  return path;
}

function parseArtifact(compressed: Buffer): Map<string, Buffer> {
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: LIMITS.archive });
  } catch {
    reject('Tarball gzip inválido.');
  }

  const files = new Map<string, Buffer>();
  let offset = 0;
  let sawTerminator = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawTerminator = true;
      break;
    }

    validateTarHeaderChecksum(header);
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const rawPath = prefix === '' ? name : prefix + '/' + name;
    const size = octal(header, 124, 12);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) reject('Tarball truncado.');
    if (typeFlag !== '0') reject('Tipo de entrada tar no permitido.');

    const path = canonicalArchivePath(rawPath);
    if (files.has(path)) reject('Archivo duplicado en tarball.');
    files.set(path, Buffer.from(archive.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!sawTerminator || files.size === 0) {
    reject('Tarball sin terminador o sin archivos.');
  }
  return files;
}

function shaField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) reject(label + ': SHA-256 inválido.');
  return value;
}

function countField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    reject(label + ': entero no negativo requerido.');
  }
  return value;
}

function localPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('*')
    || value.includes('?')
    || posix.normalize(value) !== value
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    reject(label + ': ruta no canónica.');
  }
  return value;
}

function packageCore(value: unknown, label: string, withExports: boolean): PackageCore {
  const expected = withExports
    ? ['name', 'version', 'private', 'type', 'exports']
    : ['name', 'version', 'private', 'type'];
  const object = shape(value, label, expected);

  if (
    typeof object.name !== 'string'
    || !object.name.startsWith('@pl0n3r/')
    || !PACKAGE.test(object.name)
    || typeof object.version !== 'string'
    || !VERSION.test(object.version)
    || object.private !== true
    || object.type !== 'module'
  ) {
    reject(label + ': identidad de paquete inválida.');
  }

  if (withExports) {
    const exportsValue = object.exports;
    if (typeof exportsValue !== 'object' || exportsValue === null || Array.isArray(exportsValue)) {
      reject(label + '.exports: objeto requerido.');
    }
    const entries = Object.entries(exportsValue as Obj);
    if (
      entries.length === 0
      || entries.some(([key, target]) => (
        key.trim() === ''
        || typeof target !== 'string'
        || !target.startsWith('./')
        || target.includes('://')
      ))
    ) {
      reject(label + '.exports: mapping local inválido.');
    }
  }

  return Object.freeze({
    name: object.name,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function exportMap(value: unknown, label: string): Readonly<Record<string, string>> {
  const object = shape(value, label, Object.keys(asObjectForExports(value, label)));
  const keys = Object.keys(object).sort();
  if (
    keys.length === 0
    || keys.some((key) => (
      key.trim() === ''
      || typeof object[key] !== 'string'
      || !(object[key] as string).startsWith('./')
      || (object[key] as string).includes('://')
    ))
  ) {
    reject(label + ': mapping local inválido.');
  }
  const result: Record<string, string> = {};
  for (const key of keys) result[key] = object[key] as string;
  return Object.freeze(result);
}

function asObjectForExports(value: unknown, label: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(label + ': objeto requerido.');
  }
  return value as Obj;
}

function decode(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    reject(label + ': JSON inválido.');
  }
}

function parseCli(argv: readonly string[]): Readonly<{
  artifact: string;
  provenance: string;
  dependencies: string;
}> {
  if (argv.length !== 6) reject('Se requieren tres pares flag/archivo.');
  const values = new Map<string, string>();
  for (let offset = 0; offset < argv.length; offset += 2) {
    const flag = argv[offset];
    const raw = argv[offset + 1];
    if (
      !['--artifact', '--provenance', '--dependencies'].includes(flag)
      || raw === undefined
      || raw.trim() === ''
      || values.has(flag)
    ) {
      reject('Argumentos de preflight inválidos.');
    }
    values.set(flag, raw);
  }
  if (
    !values.has('--artifact')
    || !values.has('--provenance')
    || !values.has('--dependencies')
  ) {
    reject('Falta input requerido.');
  }
  return Object.freeze({
    artifact: resolve(values.get('--artifact') as string),
    provenance: resolve(values.get('--provenance') as string),
    dependencies: resolve(values.get('--dependencies') as string),
  });
}

async function localBytes(path: string, limit: number, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > limit) {
    reject(label + ': archivo local inválido.');
  }
  return readFile(path);
}

function inspectProvenance(value: unknown): Readonly<{
  artifact: Readonly<{ filename: string; sha256: string; size: number }>;
  package: PackageCore;
  exports: Readonly<Record<string, string>>;
  allowlist: readonly string[];
  files: readonly LocalFile[];
  packageJsonSha256: string;
}> {
  const root = shape(value, 'provenance', [
    'schema_version',
    'artifact',
    'package',
    'allowlist',
    'files',
    'network_access',
    'external_mutation',
  ]);
  if (root.schema_version !== 1 || root.network_access !== false || root.external_mutation !== false) {
    reject('provenance: autoridad local inválida.');
  }

  const artifact = shape(root.artifact, 'provenance.artifact', ['filename', 'sha256', 'size']);
  if (
    typeof artifact.filename !== 'string'
    || artifact.filename === ''
    || basename(artifact.filename) !== artifact.filename
    || !artifact.filename.endsWith('.tgz')
  ) {
    reject('provenance.artifact: filename inválido.');
  }

  const packageObject = shape(
    root.package,
    'provenance.package',
    ['name', 'version', 'private', 'type', 'exports'],
  );
  const packageValue = packageCore(packageObject, 'provenance.package', true);
  const packageExports = exportMap(
    packageObject.exports,
    'provenance.package.exports',
  );

  if (!Array.isArray(root.allowlist) || root.allowlist.length === 0) {
    reject('provenance.allowlist: lista requerida.');
  }
  const allowlist = root.allowlist.map((item, index) => (
    localPath(item, 'provenance.allowlist[' + index + ']')
  ));
  if (
    new Set(allowlist).size !== allowlist.length
    || allowlist.join('\0') !== [...allowlist].sort().join('\0')
  ) {
    reject('provenance.allowlist: debe ser única y ordenada.');
  }

  if (!Array.isArray(root.files) || root.files.length === 0) {
    reject('provenance.files: lista requerida.');
  }
  const files: LocalFile[] = root.files.map((item, index) => {
    const entry = shape(item, 'provenance.files[' + index + ']', ['path', 'sha256', 'size']);
    return Object.freeze({
      path: localPath(entry.path, 'provenance.files[' + index + '].path'),
      sha256: shaField(entry.sha256, 'provenance.files[' + index + '].sha256'),
      size: countField(entry.size, 'provenance.files[' + index + '].size'),
    });
  });

  const paths = files.map((item) => item.path);
  const expected = ['README.md', 'package.json', ...allowlist].sort();
  if (
    new Set(paths).size !== paths.length
    || paths.join('\0') !== [...paths].sort().join('\0')
    || paths.length !== expected.length
    || paths.some((path, index) => path !== expected[index])
  ) {
    reject('provenance.files: file-list no coincide con allowlist.');
  }

  const manifest = files.find((item) => item.path === 'package.json');
  if (manifest === undefined) reject('provenance.files: falta package.json.');

  return Object.freeze({
    artifact: Object.freeze({
      filename: artifact.filename,
      sha256: shaField(artifact.sha256, 'provenance.artifact.sha256'),
      size: countField(artifact.size, 'provenance.artifact.size'),
    }),
    package: packageValue,
    exports: packageExports,
    allowlist: Object.freeze(allowlist),
    files: Object.freeze(files),
    packageJsonSha256: manifest.sha256,
  });
}

function sameExports(
  value: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = value as Obj;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length
    && keys.every((key, index) => (
      key === expectedKeys[index]
      && actual[key] === expected[key]
    ))
  );
}

function verifyArtifactContents(
  artifactBody: Buffer,
  provenance: Readonly<{
    package: PackageCore;
    exports: Readonly<Record<string, string>>;
    allowlist: readonly string[];
    files: readonly LocalFile[];
  }>,
): string {
  const archive = parseArtifact(artifactBody);
  const expectedPaths = ['README.md', 'package.json', ...provenance.allowlist].sort();
  const actualPaths = [...archive.keys()].sort();

  if (
    actualPaths.length !== expectedPaths.length
    || actualPaths.some((path, index) => path !== expectedPaths[index])
    || provenance.files.length !== expectedPaths.length
  ) {
    reject('File-list real del tarball diverge de provenance.');
  }

  for (let index = 0; index < provenance.files.length; index += 1) {
    const expected = provenance.files[index];
    if (expected.path !== expectedPaths[index]) {
      reject('Orden de provenance.files diverge del artefacto real.');
    }
    const body = archive.get(expected.path);
    if (
      body === undefined
      || expected.size !== body.length
      || expected.sha256 !== digest(body)
    ) {
      reject('Hash o tamaño interno diverge del artefacto real.');
    }
  }

  const packageBody = archive.get('package.json');
  if (packageBody === undefined) reject('Falta package.json en el tarball.');
  const actualPackage = shape(
    decode(packageBody, 'package.json del tarball'),
    'package.json del tarball',
    Object.keys(
      asObjectForExports(
        decode(packageBody, 'package.json del tarball'),
        'package.json del tarball',
      ),
    ),
  );
  if (
    actualPackage.name !== provenance.package.name
    || actualPackage.version !== provenance.package.version
    || actualPackage.private !== provenance.package.private
    || actualPackage.type !== provenance.package.type
    || !sameExports(actualPackage.exports, provenance.exports)
  ) {
    reject('Metadata real del paquete diverge de provenance.');
  }

  return digest(packageBody);
}

function inspectDependencies(value: unknown): Readonly<{
  package: PackageCore;
  manifestSha256: string;
}> {
  const root = shape(value, 'dependency evidence', [
    'schema_version',
    'package',
    'source',
    'runtime_dependencies',
    'network_access',
    'external_mutation',
  ]);
  if (root.schema_version !== 1 || root.network_access !== false || root.external_mutation !== false) {
    reject('dependency evidence: autoridad local inválida.');
  }

  const source = shape(
    root.source,
    'dependency evidence.source',
    ['manifest_sha256', 'lockfile_sha256', 'lockfile_version'],
  );
  const manifestSha256 = shaField(
    source.manifest_sha256,
    'dependency evidence.source.manifest_sha256',
  );
  shaField(source.lockfile_sha256, 'dependency evidence.source.lockfile_sha256');
  if (source.lockfile_version !== 3) reject('dependency evidence: lockfile no soportado.');

  if (!Array.isArray(root.runtime_dependencies)) {
    reject('dependency evidence.runtime_dependencies: lista requerida.');
  }
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const [index, item] of root.runtime_dependencies.entries()) {
    const dep = shape(
      item,
      'dependency evidence.runtime_dependencies[' + index + ']',
      ['name', 'specifier', 'locked_version'],
    );
    if (
      typeof dep.name !== 'string'
      || !PACKAGE.test(dep.name)
      || typeof dep.specifier !== 'string'
      || dep.specifier.trim() === ''
      || dep.specifier.includes('://')
      || typeof dep.locked_version !== 'string'
      || !VERSION.test(dep.locked_version)
      || seen.has(dep.name)
      || (previous !== null && previous >= dep.name)
    ) {
      reject('dependency evidence: dependencia runtime no canónica.');
    }
    seen.add(dep.name);
    previous = dep.name;
  }

  return Object.freeze({
    package: packageCore(root.package, 'dependency evidence.package', false),
    manifestSha256,
  });
}

function samePackage(left: PackageCore, right: PackageCore): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

async function main(): Promise<void> {
  const input = parseCli(process.argv.slice(2));
  const [artifactBody, provenanceBody, dependencyBody] = await Promise.all([
    localBytes(input.artifact, LIMITS.artifact, 'artifact'),
    localBytes(input.provenance, LIMITS.evidence, 'provenance'),
    localBytes(input.dependencies, LIMITS.evidence, 'dependency evidence'),
  ]);

  const provenance = inspectProvenance(decode(provenanceBody, 'provenance'));
  const dependencies = inspectDependencies(decode(dependencyBody, 'dependency evidence'));

  if (
    basename(input.artifact) !== provenance.artifact.filename
    || artifactBody.length !== provenance.artifact.size
    || digest(artifactBody) !== provenance.artifact.sha256
  ) {
    reject('artifact: no coincide exactamente con provenance.');
  }
  const actualPackageJsonSha256 = verifyArtifactContents(
    artifactBody,
    provenance,
  );
  if (!samePackage(provenance.package, dependencies.package)) {
    reject('package: metadata divergente entre evidencias.');
  }
  if (
    provenance.packageJsonSha256 !== actualPackageJsonSha256
    || dependencies.manifestSha256 !== actualPackageJsonSha256
  ) {
    reject('package.json: hash real divergente entre evidencias.');
  }

  process.stdout.write(JSON.stringify({
    accepted: true,
    artifact_sha256: provenance.artifact.sha256,
    package: provenance.package,
    runtime_evidence_bound: true,
    network_access: false,
    external_mutation: false,
  }) + '\n');
}

await main();
