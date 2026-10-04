import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  repo: string;
  output: string;
}>;

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

function parseOptions(argv: readonly string[]): Options {
  if (argv.length !== 4) {
    fail(
      'Uso: create-observability-exact-main-source-snapshot.ts '
      + '--repo <repositorio-local> --output <snapshot.json>',
    );
  }

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--repo', '--output'].includes(key)
      || value === undefined
      || value.trim() === ''
      || values.has(key)
    ) {
      fail('Argumentos inválidos.');
    }
    values.set(key, value);
  }

  const repo = resolve(values.get('--repo') as string);
  const output = resolve(values.get('--output') as string);
  const fromRepo = relative(repo, output);
  const normalizedFromRepo = fromRepo.split(sep).join('/');
  if (
    fromRepo === ''
    || isAbsolute(fromRepo)
    || (normalizedFromRepo !== '..' && !normalizedFromRepo.startsWith('../'))
  ) {
    fail('El snapshot debe escribirse fuera del repositorio.');
  }

  return Object.freeze({ repo, output });
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

function packageContract(value: unknown): {
  identity: PackageIdentity;
  sourcePaths: readonly string[];
} {
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

  const sourcePaths = manifest.files.map((entry) => {
    if (
      typeof entry !== 'string'
      || !entry.startsWith('src/')
      || !entry.endsWith('.ts')
      || entry.includes('*')
      || entry.includes('?')
    ) {
      fail('package.json: ruta source inválida.');
    }
    const path = canonicalPath(entry);
    rejectSensitivePath(path);
    return path;
  });
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    fail('package.json: files contiene duplicados.');
  }
  const sorted = [...sourcePaths].sort(compareText);
  if (sourcePaths.some((path, index) => path !== sorted[index])) {
    fail('package.json: files debe estar ordenado.');
  }

  return {
    identity: Object.freeze({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
    }),
    sourcePaths: Object.freeze(sourcePaths),
  };
}

function git(repo: string, args: readonly string[], label: string): string {
  const completed = spawnSync(
    'git',
    ['-C', repo, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
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

async function sourceFiles(
  repo: string,
  paths: readonly string[],
): Promise<readonly SourceFile[]> {
  const status = git(
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths],
    'worktree status',
  );
  if (status !== '') fail('Worktree dirty en paths de release.');

  let total = 0;
  const result: SourceFile[] = [];
  for (const path of paths) {
    canonicalPath(path);
    rejectSensitivePath(path);
    const absolute = resolve(repo, ...path.split('/'));
    const boundary = relative(repo, absolute);
    const normalizedBoundary = boundary.split(sep).join('/');
    if (
      boundary === ''
      || isAbsolute(boundary)
      || normalizedBoundary === '..'
      || normalizedBoundary.startsWith('../')
      || normalizedBoundary !== path
    ) {
      fail('Ruta source fuera del repositorio.');
    }

    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('Source debe ser archivo regular sin symlink.');
    }
    if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES) {
      fail('Source fuera de límites.');
    }
    total += metadata.size;
    if (total > MAX_TOTAL_BYTES) fail('Source total fuera de límites.');

    const headBlob = git(repo, ['rev-parse', '--verify', `HEAD:${path}`], 'HEAD source blob');
    const worktreeBlob = git(repo, ['hash-object', '--', path], 'worktree source blob');
    if (!SHA1_RE.test(headBlob) || !SHA1_RE.test(worktreeBlob) || headBlob !== worktreeBlob) {
      fail('Source local no coincide exactamente con HEAD.');
    }

    const body = await readFile(absolute);
    const digest = sha256(body);
    if (!SHA256_RE.test(digest)) fail('SHA-256 de source inválido.');
    result.push(Object.freeze({ path, sha256: digest, size: body.length }));
  }

  result.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze(result);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repoStat = await stat(options.repo);
  if (!repoStat.isDirectory()) fail('Repositorio local inválido.');

  const packageBody = await readFile(resolve(options.repo, 'package.json'), 'utf8');
  const contract = packageContract(parseJson(packageBody, 'package.json'));
  const paths = [...new Set([
    ...RELEASE_SUPPORT_PATHS,
    ...contract.sourcePaths,
  ])].sort(compareText);

  for (const path of paths) {
    canonicalPath(path);
    rejectSensitivePath(path);
  }

  const identity = exactMain(options.repo);
  const files = await sourceFiles(options.repo, paths);
  const sourceFingerprintBody = JSON.stringify(canonicalValue(files), null, 2) + '\n';
  const sourceSha256 = sha256(sourceFingerprintBody);

  const snapshot = {
    schema_version: 1,
    package: contract.identity,
    repository: {
      ref: 'refs/heads/main',
      commit_sha: identity.commit,
      tree_sha: identity.tree,
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
  await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'wx' });
}

await main();
