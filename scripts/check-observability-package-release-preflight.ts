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
type RuntimeReference = Readonly<{ name: string; specifier: string }>;
type LockedRuntimeReference = Readonly<{
  name: string;
  specifier: string;
  locked_version: string;
}>;

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LIMITS = Object.freeze({
  artifact: 32 * 1024 * 1024,
  archive: 16 * 1024 * 1024,
  evidence: 4 * 1024 * 1024,
});

function reject(message: string): never {
  throw new Error(message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return left.localeCompare(right, 'en');
}

function shape(value: unknown, label: string, expected: readonly string[]): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(label + ': objeto requerido.');
  }
  const object = value as Obj;
  const actual = Object.keys(object).sort(compareText);
  const wanted = [...expected].sort(compareText);
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

  if (withExports) normalizeExports(object.exports, label + '.exports');

  return Object.freeze({
    name: object.name,
    version: object.version,
    private: true,
    type: 'module',
  });
}

function normalizeExports(value: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(label + ': objeto requerido.');
  }
  const result: Record<string, string> = {};
  for (const [key, target] of Object.entries(value as Obj).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    if (
      key.trim() === ''
      || typeof target !== 'string'
      || !target.startsWith('./')
      || target.includes('://')
    ) {
      reject(label + ': mapping local inválido.');
    }
    result[key] = target;
  }
  if (Object.keys(result).length === 0) reject(label + ': vacío.');
  return Object.freeze(result);
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

function tarText(block: Buffer, start: number, width: number): string {
  return block.subarray(start, start + width).toString('utf8').split('\0', 1)[0];
}

function tarNumber(block: Buffer, start: number, width: number): number {
  const token = tarText(block, start, width).trim();
  if (token === '') return 0;
  if (!/^[0-7]+$/.test(token)) reject('artifact: campo octal tar inválido.');
  const parsed = Number.parseInt(token, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject('artifact: tamaño tar inválido.');
  return parsed;
}

function verifyTarHeader(header: Buffer): void {
  const checksumExpected = tarNumber(header, 148, 8);
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const checksumActual = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (checksumActual !== checksumExpected) reject('artifact: checksum tar inválido.');
}

function tarEntryPath(header: Buffer): string {
  const type = header[156];
  if (type !== 0 && type !== 0x30) reject('artifact: tipo tar no permitido.');

  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  const raw = prefix === '' ? name : prefix + '/' + name;
  if (!raw.startsWith('package/')) reject('artifact: entry fuera de package/.');
  return localPath(raw.slice('package/'.length), 'artifact entry');
}

function archiveEntries(compressed: Buffer): Map<string, Buffer> {
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: LIMITS.archive });
  } catch {
    reject('artifact: gzip inválido o expansión excesiva.');
  }

  const entries = new Map<string, Buffer>();
  let cursor = 0;
  let terminated = false;

  while (cursor + 512 <= archive.length) {
    const header = archive.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }

    verifyTarHeader(header);
    const path = tarEntryPath(header);

    const size = tarNumber(header, 124, 12);
    const dataStart = cursor + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) reject('artifact: tar truncado.');
    if (entries.has(path)) reject('artifact: entry duplicado.');
    entries.set(path, Buffer.from(archive.subarray(dataStart, dataEnd)));

    cursor = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!terminated || entries.size === 0) reject('artifact: tar sin terminador o vacío.');
  return entries;
}

function semverParts(value: string, label: string): readonly bigint[] {
  if (!VERSION.test(value)) reject(label + ': semver no soportado.');
  return Object.freeze(value.split('.').map((part) => BigInt(part)));
}

function compareSemver(left: readonly bigint[], right: readonly bigint[]): number {
  const changed = left.findIndex((value, index) => value !== right[index]);
  if (changed === -1) return 0;
  return left[changed] < right[changed] ? -1 : 1;
}

function normalizeSpecifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject(label + ': specifier requerido.');
  }
  const specifier = value.trim();
  const base = specifier.startsWith('^') || specifier.startsWith('~')
    ? specifier.slice(1)
    : specifier;
  if (!VERSION.test(base)) {
    reject(label + ': solo se soporta exact, ^ o ~ sobre x.y.z.');
  }
  return specifier;
}

function lockedVersionSatisfies(specifier: string, lockedVersion: string): boolean {
  const operator = specifier.startsWith('^') || specifier.startsWith('~')
    ? specifier[0]
    : '';
  const floor = semverParts(operator === '' ? specifier : specifier.slice(1), 'specifier');
  const locked = semverParts(lockedVersion, 'locked_version');
  if (operator === '') return compareSemver(locked, floor) === 0;
  if (compareSemver(locked, floor) < 0) return false;

  const [major, minor, patch] = floor;
  const ceiling = operator === '~'
    ? [major, minor + 1n, 0n]
    : major > 0n
      ? [major + 1n, 0n, 0n]
      : minor > 0n
        ? [0n, minor + 1n, 0n]
        : [0n, 0n, patch + 1n];

  return compareSemver(locked, ceiling) < 0;
}

function dependencyMap(value: unknown, label: string): readonly RuntimeReference[] {
  if (value === undefined) return Object.freeze([]);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(label + ': objeto requerido.');
  }
  const result: RuntimeReference[] = [];
  for (const name of Object.keys(value as Obj).sort(compareText)) {
    const specifier = (value as Obj)[name];
    if (!PACKAGE.test(name)) {
      reject(label + ': nombre de dependencia inválido.');
    }
    result.push(Object.freeze({
      name,
      specifier: normalizeSpecifier(specifier, label + '.' + name),
    }));
  }
  return Object.freeze(result);
}

function inspectPackedPackage(body: Buffer): Readonly<{
  package: PackageCore;
  exports: Readonly<Record<string, string>>;
  files: readonly string[];
  dependencies: readonly RuntimeReference[];
}> {
  const parsed = decode(body, 'artifact package.json');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reject('artifact package.json: objeto requerido.');
  }
  const object = parsed as Obj;
  const required = ['name', 'version', 'private', 'type', 'exports', 'files'];
  const allowed = new Set([...required, 'engines', 'dependencies']);
  if (
    required.some((key) => !(key in object))
    || Object.keys(object).some((key) => !allowed.has(key))
  ) {
    reject('artifact package.json: schema desconocido o incompleto.');
  }

  const core = packageCore(
    {
      name: object.name,
      version: object.version,
      private: object.private,
      type: object.type,
    },
    'artifact package.json',
    false,
  );
  const exportsValue = normalizeExports(object.exports, 'artifact package.json.exports');

  if (!Array.isArray(object.files) || object.files.length === 0) {
    reject('artifact package.json.files: lista requerida.');
  }
  const files = object.files.map((item, index) => (
    localPath(item, 'artifact package.json.files[' + index + ']')
  ));
  if (
    new Set(files).size !== files.length
    || files.join('\0') !== [...files].sort(compareText).join('\0')
  ) {
    reject('artifact package.json.files: debe ser única y ordenada.');
  }

  if (object.engines !== undefined) {
    if (
      typeof object.engines !== 'object'
      || object.engines === null
      || Array.isArray(object.engines)
      || Object.values(object.engines as Obj).some((item) => typeof item !== 'string')
    ) {
      reject('artifact package.json.engines: inválido.');
    }
  }

  return Object.freeze({
    package: core,
    exports: exportsValue,
    files: Object.freeze(files),
    dependencies: dependencyMap(object.dependencies, 'artifact package.json.dependencies'),
  });
}

function inspectProvenance(value: unknown): Readonly<{
  artifact: Readonly<{ filename: string; sha256: string; size: number }>;
  package: PackageCore;
  exports: Readonly<Record<string, string>>;
  allowlist: readonly string[];
  files: readonly LocalFile[];
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
  const exportsValue = normalizeExports(packageObject.exports, 'provenance.package.exports');

  if (!Array.isArray(root.allowlist) || root.allowlist.length === 0) {
    reject('provenance.allowlist: lista requerida.');
  }
  const allowlist = root.allowlist.map((item, index) => (
    localPath(item, 'provenance.allowlist[' + index + ']')
  ));
  if (
    new Set(allowlist).size !== allowlist.length
    || allowlist.join('\0') !== [...allowlist].sort(compareText).join('\0')
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
  const expected = ['README.md', 'package.json', ...allowlist].sort(compareText);
  if (
    new Set(paths).size !== paths.length
    || paths.join('\0') !== [...paths].sort(compareText).join('\0')
    || paths.length !== expected.length
    || paths.some((path, index) => path !== expected[index])
  ) {
    reject('provenance.files: file-list no coincide con allowlist.');
  }

  return Object.freeze({
    artifact: Object.freeze({
      filename: artifact.filename,
      sha256: shaField(artifact.sha256, 'provenance.artifact.sha256'),
      size: countField(artifact.size, 'provenance.artifact.size'),
    }),
    package: packageValue,
    exports: exportsValue,
    allowlist: Object.freeze(allowlist),
    files: Object.freeze(files),
  });
}

function inspectDependencies(value: unknown): Readonly<{
  package: PackageCore;
  manifestSha256: string;
  runtime: readonly LockedRuntimeReference[];
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
  const runtime: LockedRuntimeReference[] = [];
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
      || typeof dep.locked_version !== 'string'
      || !VERSION.test(dep.locked_version)
      || (previous !== null && compareText(previous, dep.name) >= 0)
    ) {
      reject('dependency evidence: dependencia runtime no canónica.');
    }
    const specifier = normalizeSpecifier(
      dep.specifier,
      'dependency evidence.runtime_dependencies[' + index + '].specifier',
    );
    if (!lockedVersionSatisfies(specifier, dep.locked_version)) {
      reject('dependency evidence: locked_version fuera del specifier.');
    }
    runtime.push(Object.freeze({
      name: dep.name,
      specifier,
      locked_version: dep.locked_version,
    }));
    previous = dep.name;
  }

  return Object.freeze({
    package: packageCore(root.package, 'dependency evidence.package', false),
    manifestSha256,
    runtime: Object.freeze(runtime),
  });
}

function samePackage(left: PackageCore, right: PackageCore): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.private === right.private
    && left.type === right.type;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const archived = archiveEntries(artifactBody);

  if (
    basename(input.artifact) !== provenance.artifact.filename
    || artifactBody.length !== provenance.artifact.size
    || digest(artifactBody) !== provenance.artifact.sha256
  ) {
    reject('artifact: no coincide exactamente con provenance.');
  }

  const actualFiles = [...archived.entries()]
    .map(([path, body]) => Object.freeze({ path, sha256: digest(body), size: body.length }))
    .sort((left, right) => compareText(left.path, right.path));
  if (!sameJson(actualFiles, provenance.files)) {
    reject('artifact: file-list o hashes internos divergen de provenance.');
  }

  const packageBody = archived.get('package.json');
  if (packageBody === undefined) reject('artifact: falta package.json.');
  const packed = inspectPackedPackage(packageBody);

  if (
    !samePackage(packed.package, provenance.package)
    || !samePackage(packed.package, dependencies.package)
    || !sameJson(packed.exports, provenance.exports)
    || !sameJson(packed.files, provenance.allowlist)
  ) {
    reject('artifact package.json: metadata diverge de las evidencias.');
  }

  if (digest(packageBody) !== dependencies.manifestSha256) {
    reject('artifact package.json: hash diverge de dependency evidence.');
  }
  const evidenceRuntime = dependencies.runtime.map(({ name, specifier }) => (
    Object.freeze({ name, specifier })
  ));
  if (!sameJson(packed.dependencies, evidenceRuntime)) {
    reject('artifact package.json: dependencias runtime divergen de la evidencia.');
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
