import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type PackageIdentity = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
}>;

type SourceFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const GIT_BINARY = '/usr/bin/git';
const TRUSTED_PATH = '/usr/bin:/bin';
const SNAPSHOT_FILENAME = '.factoryrunner-exact-main-source-snapshot.json';

const RELEASE_SUPPORT_PATHS = Object.freeze([
  'README.md',
  'package-lock.json',
  'package.json',
  'scripts/build-observability-package-dependency-evidence.ts',
  'scripts/build-observability-package-provenance.ts',
  'scripts/build-observability-package.ts',
  'scripts/check-observability-package-release-preflight.ts',
  'scripts/check-observability-package-release-receipt.ts',
  'scripts/check-observability-package-verified-consumer.ts',
  'scripts/create-observability-package-release-receipt.ts',
]);

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

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort(compareText)) {
      result[key] = canonicalValue((value as JsonObject)[key]);
    }
    return result;
  }
  fail('Valor no serializable.');
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    fail(label + ' no contiene JSON válido.');
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label + ': objeto requerido.');
  }
  return value as JsonObject;
}

function canonicalPath(path: string): string {
  if (
    path === ''
    || path.startsWith('/')
    || path.includes('\\')
    || posix.normalize(path) !== path
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('Ruta de source no canónica.');
  }
  return path;
}

function rejectSensitivePath(path: string): void {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const forbiddenSegments = new Set([
    '.env',
    'secret',
    'secrets',
    'credential',
    'credentials',
    'private-key',
    'private_key',
    'id_rsa',
  ]);
  const hasSensitiveSegment = segments.some((segment) => {
    const stem = segment.replace(/\.[^.]+$/, '');
    return forbiddenSegments.has(segment) || forbiddenSegments.has(stem);
  });
  if (
    hasSensitiveSegment
    || ['.pem', '.key', '.p12', '.pfx'].some((suffix) => lower.endsWith(suffix))
  ) {
    fail('Ruta sensible no permitida en evidencia de source.');
  }
}

function packageIdentity(value: unknown): Readonly<{ identity: PackageIdentity; sourcePaths: readonly string[] }> {
  const manifest = asObject(value, 'package.json');
  if (
    typeof manifest.name !== 'string'
    || !manifest.name.startsWith('@pl0n3r/')
    || !PACKAGE_RE.test(manifest.name)
    || typeof manifest.version !== 'string'
    || !VERSION_RE.test(manifest.version)
    || manifest.private !== true
    || manifest.type !== 'module'
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0
  ) {
    fail('package.json: contrato de release inválido.');
  }

  const exportsValue = asObject(manifest.exports, 'package.json exports');
  const exportKeys = Object.keys(exportsValue).sort(compareText);
  if (
    exportKeys.length !== 2
    || exportKeys[0] !== '.'
    || exportKeys[1] !== './recovery-handoff'
    || exportsValue['.'] !== './src/browser-remote-observability-public.ts'
    || exportsValue['./recovery-handoff'] !== './src/execution-recovery-handoff-public.ts'
  ) {
    fail('package.json: exports de release inválidos.');
  }

  const PACKAGE_SOURCE_PATHS = manifest.files.map((entry) => {
    if (typeof entry !== 'string') fail('package.json: files inválido.');
    const path = canonicalPath(entry);
    rejectSensitivePath(path);
    if (!path.startsWith('src/') || !path.endsWith('.ts')) {
      fail('package.json: source fuera de src/ o no TypeScript.');
    }
    return path;
  }).sort(compareText);
  if (
    new Set(PACKAGE_SOURCE_PATHS).size !== PACKAGE_SOURCE_PATHS.length
    || manifest.files.some((entry, index) => entry !== PACKAGE_SOURCE_PATHS[index])
  ) {
    fail('package.json: files debe ser único y ordenado.');
  }

  return Object.freeze({
    identity: Object.freeze({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
    }),
    sourcePaths: Object.freeze(PACKAGE_SOURCE_PATHS),
  });
}

function git(repo: string, args: readonly string[], label: string): string {
  const completed = spawnSync(
    GIT_BINARY,
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-C',
      repo,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
      env: {
        PATH: TRUSTED_PATH,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        LC_ALL: 'C',
        LANG: 'C',
      },
    },
  );
  if (
    completed.error !== undefined
    || completed.status !== 0
    || typeof completed.stdout !== 'string'
  ) {
    fail(label + ': Git local rechazó la operación.');
  }
  return completed.stdout.trim();
}

function exactMain(repo: string): Readonly<{ commit: string; tree: string }> {
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'branch');
  if (branch !== 'main') fail('HEAD no apunta de forma inequívoca a main.');

  const commit = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 'HEAD commit');
  const mainCommit = git(
    repo,
    ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
    'main commit',
  );
  const tree = git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'], 'HEAD tree');
  if (!SHA1_RE.test(commit) || !SHA1_RE.test(tree) || commit !== mainCommit) {
    fail('Identidad exact-main inválida o ambigua.');
  }
  return Object.freeze({ commit, tree });
}

async function sourceFiles(repo: string, releaseSourcePaths: readonly string[]): Promise<readonly SourceFile[]> {
  const status = git(
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...releaseSourcePaths],
    'worktree status',
  );
  if (status !== '') fail('Worktree dirty en paths de release.');

  const entries = await Promise.all(releaseSourcePaths.map(async (path) => {
    canonicalPath(path);
    rejectSensitivePath(path);
    const absolute = resolve(repo, ...path.split('/'));
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('Source debe ser archivo regular sin symlink.');
    }
    if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES) {
      fail('Source fuera de límites.');
    }
    return Object.freeze({ path, absolute, size: metadata.size });
  }));

  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_TOTAL_BYTES) fail('Source total fuera de límites.');

  const result = await Promise.all(entries.map(async ({ path, absolute }) => {
    const headBlob = git(repo, ['rev-parse', '--verify', `HEAD:${path}`], 'HEAD source blob');
    const worktreeBlob = git(repo, ['hash-object', '--', path], 'worktree source blob');
    if (!SHA1_RE.test(headBlob) || !SHA1_RE.test(worktreeBlob) || headBlob !== worktreeBlob) {
      fail('Source local no coincide exactamente con HEAD.');
    }

    const body = await readFile(absolute);
    const digest = sha256(body);
    if (!SHA256_RE.test(digest)) fail('SHA-256 de source inválido.');
    return Object.freeze({ path, sha256: digest, size: body.length });
  }));

  result.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze(result);
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) fail('Este script no acepta paths por argumentos.');

  const repo = process.cwd();
  const output = resolve(repo, '..', SNAPSHOT_FILENAME);
  const packageBody = await readFile(resolve(repo, 'package.json'), 'utf8');
  const packageContract = packageIdentity(parseJson(packageBody, 'package.json'));
  const identity = packageContract.identity;
  const releaseSourcePaths = Object.freeze(
    [...RELEASE_SUPPORT_PATHS, ...packageContract.sourcePaths].sort(compareText),
  );
  const sourceIdentity = exactMain(repo);
  const files = await sourceFiles(repo, releaseSourcePaths);
  const sourceFingerprintBody = JSON.stringify(canonicalValue(files), null, 2) + '\n';
  const sourceSha256 = sha256(sourceFingerprintBody);

  const snapshot = {
    schema_version: 1,
    package: identity,
    repository: {
      ref: 'refs/heads/main',
      commit_sha: sourceIdentity.commit,
      tree_sha: sourceIdentity.tree,
    },
    source: {
      sha256: sourceSha256,
      files,
    },
    verification: {
      exact_main: true,
      worktree_clean: true,
      tracked_sources: true,
    },
    authority: 'unchanged',
    network_access: false,
    external_mutation: false,
  };

  const serialized = JSON.stringify(canonicalValue(snapshot), null, 2) + '\n';
  if (
    !SHA256_RE.test(sourceSha256)
    || Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES
  ) {
    fail('Snapshot fuera de límites.');
  }
  await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

await main();
