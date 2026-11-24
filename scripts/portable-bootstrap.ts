/** Reversible, synthetic OFFLINE_ONLY bootstrap. Never runs the actual runner. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeLocal, portablePreflight, type PortableReport } from './portable-preflight.ts';

export type Action = 'doctor' | 'install' | 'start' | 'stop' | 'status' | 'update' | 'rollback';
type Phase = 'NOT_INSTALLED' | 'STOPPED' | 'SIMULATED_ACTIVE';
type Release = { version: string; sha: string };
type State = { schema_version: 1; release: Release; previous: Release | null; phase: Exclude<Phase, 'NOT_INSTALLED'> };
export type Options = { workspace: string; artifact?: string; sha?: string };
export type Result = { schema_version: 1; scope: 'OFFLINE_ONLY'; status: 'SUPPORTED_OFFLINE' | 'UNAVAILABLE' | 'UNKNOWN';
  action: Action; phase: Phase; version: string | null; artifact_sha256: string | null;
  authority: 'unchanged'; network_access: false; production_execution: false; reason?: string };
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ACTIONS: readonly Action[] = ['doctor', 'install', 'start', 'stop', 'status', 'update', 'rollback'];
class OfflineError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const reject = (code: string): never => { throw new OfflineError(code); };

/** Only a direct child named runner of a fresh, explicitly passed OS temp sandbox. */
function sandbox(workspace: string): { root: string; workspace: string } {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace || basename(workspace) !== 'runner') reject('UNSAFE_WORKSPACE');
  const root = dirname(workspace);
  if (dirname(root) !== realpathSync(tmpdir()) || !/^factoryrunner-offline-[A-Za-z0-9_-]{6,}$/.test(basename(root))) reject('UNSAFE_WORKSPACE');
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) reject('UNSAFE_WORKSPACE');
  if (existsSync(workspace) && (!lstatSync(workspace).isDirectory() || realpathSync(workspace) !== workspace)) reject('UNSAFE_WORKSPACE');
  return { root, workspace };
}
function safeFile(path: string): boolean {
  try { return lstatSync(path).isFile() && realpathSync(path) === path; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
function loadState(workspace: string): State | null {
  const file = join(workspace, 'state.json');
  if (!existsSync(workspace) || !existsSync(file)) return null;
  if (!safeFile(file)) reject('UNSAFE_WORKSPACE');
  const raw = readFileSync(file, 'utf8');
  if (raw.length > 1024) reject('INVALID_STATE');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return reject('INVALID_STATE'); }
  if (!data || typeof data !== 'object') reject('INVALID_STATE');
  const d = data as Partial<State>;
  const release = (value: unknown): value is Release => !!value && typeof value === 'object' &&
    typeof (value as Release).version === 'string' && VERSION.test((value as Release).version) &&
    typeof (value as Release).sha === 'string' && SHA.test((value as Release).sha) &&
    Object.keys(value).sort().join(',') === 'sha,version';
  if (d.schema_version !== 1 || !release(d.release) || (d.previous !== null && !release(d.previous)) ||
      (d.phase !== 'STOPPED' && d.phase !== 'SIMULATED_ACTIVE') ||
      Object.keys(d).sort().join(',') !== 'phase,previous,release,schema_version') reject('INVALID_STATE');
  return d as State;
}
function localRelease(root: string, opts: Options): Release {
  const source = opts.artifact, sha = opts.sha;
  if (typeof source !== 'string' || typeof sha !== 'string') throw new OfflineError('INVALID_ARTIFACT');
  if (!isAbsolute(source) || resolve(source) !== source ||
      dirname(dirname(source)) !== root || basename(dirname(source)) !== 'releases' ||
      !/^release-[A-Za-z0-9_.-]+\.json$/.test(basename(source)) || !SHA.test(sha)) reject('INVALID_ARTIFACT');
  const releases = dirname(source);
  if (!lstatSync(releases).isDirectory() || realpathSync(releases) !== releases || !safeFile(source) || !existsSync(source)) reject('INVALID_ARTIFACT');
  const bytes = readFileSync(source);
  if (bytes.length > 1024 || createHash('sha256').update(bytes).digest('hex') !== sha) reject('ARTIFACT_SHA_MISMATCH');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return reject('INVALID_ARTIFACT'); }
  const v = parsed as Record<string, unknown> | null;
  const version = v?.version;
  if (!v || v.schema_version !== 1 || v.kind !== 'OFFLINE_FIXTURE' || typeof version !== 'string' ||
      !VERSION.test(version) || Object.keys(v).sort().join(',') !== 'kind,schema_version,version') reject('INVALID_ARTIFACT');
  return { version: version as string, sha };
}
function versionParts(v: string): number[] { return v.split('.').map(Number); }
function newer(next: string, current: string): boolean {
  const a = versionParts(next), b = versionParts(current);
  if (a[0] !== b[0]) reject('VERSION_INCOMPATIBLE');
  for (let i = 1; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function persist(workspace: string, state: State): void {
  const target = join(workspace, 'state.json');
  if (!safeFile(target)) reject('UNSAFE_WORKSPACE');
  const temp = join(workspace, `.state-${randomUUID()}.json`);
  try {
    writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function exclusive<T>(workspace: string, task: () => T): T {
  const file = join(workspace, 'operation.lock');
  let descriptor: number;
  try { descriptor = openSync(file, 'wx', 0o600); } catch { return reject('WORKSPACE_BUSY'); }
  try { return task(); } finally { closeSync(descriptor); unlinkSync(file); }
}
function envelope(action: Action, state: State | null, status: Result['status'], reason?: string): Result {
  return { schema_version: 1, scope: 'OFFLINE_ONLY', status, action,
    phase: state?.phase ?? 'NOT_INSTALLED', version: state?.release.version ?? null,
    artifact_sha256: state?.release.sha ?? null,
    authority: 'unchanged', network_access: false, production_execution: false,
    ...(reason ? { reason } : {}) };
}

export function portableBootstrap(action: Action, opts: Options, observed: PortableReport = portablePreflight(observeLocal())): Result {
  try {
    if (!ACTIONS.includes(action)) reject('UNKNOWN_ACTION');
    const { root, workspace } = sandbox(opts.workspace);
    if (observed.status !== 'SUPPORTED_OFFLINE') return envelope(action, null, observed.status, 'CAPABILITY_UNAVAILABLE');
    if (action === 'doctor') return envelope(action, null, observed.status);
    const target = action === 'install' || action === 'update' ? localRelease(root, opts) : null;
    if (action === 'install' && !existsSync(workspace)) mkdirSync(workspace, { mode: 0o700 });
    if (!existsSync(workspace)) return envelope(action, null, 'UNAVAILABLE', 'NOT_INSTALLED');
    if (!lstatSync(workspace).isDirectory() || realpathSync(workspace) !== workspace) reject('UNSAFE_WORKSPACE');
    if (action === 'status') {
      const state = loadState(workspace);
      return envelope(action, state, state ? 'SUPPORTED_OFFLINE' : 'UNAVAILABLE', state ? undefined : 'NOT_INSTALLED');
    }
    return exclusive(workspace, () => {
      const current = loadState(workspace);
      let state: State;
      if (action === 'install') {
        if (target === null) throw new OfflineError('INVALID_ARTIFACT');
        if (current && (current.release.version !== target.version || current.release.sha !== target.sha)) reject('ALREADY_INSTALLED');
        state = current ?? { schema_version: 1, release: target, previous: null, phase: 'STOPPED' };
      } else {
        if (current === null) throw new OfflineError('NOT_INSTALLED');
        state = current;
        if (action === 'start') state = { ...state, phase: 'SIMULATED_ACTIVE' };
        if (action === 'stop') state = { ...state, phase: 'STOPPED' };
        if (action === 'update') {
          if (target === null) throw new OfflineError('INVALID_ARTIFACT');
          if (state.phase !== 'STOPPED') reject('STOP_REQUIRED');
          if (state.release.version === target.version && state.release.sha !== target.sha) reject('VERSION_DRIFT');
          if (state.release.version !== target.version) {
            if (!newer(target.version, state.release.version)) reject('VERSION_INCOMPATIBLE');
            state = { ...state, previous: state.release, release: target };
          }
        }
        if (action === 'rollback') {
          if (state.phase !== 'STOPPED') reject('STOP_REQUIRED');
          if (state.previous === null) throw new OfflineError('NO_ROLLBACK');
          state = { ...state, release: state.previous, previous: null };
        }
      }
      persist(workspace, state);
      return envelope(action, state, 'SUPPORTED_OFFLINE');
    });
  } catch (error) {
    return envelope(action, null, 'UNAVAILABLE', error instanceof OfflineError ? error.code : 'UNAVAILABLE');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const action = args.shift() as Action;
  const allowed = new Set(['--workspace', '--artifact', '--sha']);
  const opts: Record<string, string> = {};
  let valid = ACTIONS.includes(action) && args.length % 2 === 0;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!allowed.has(key) || !value || key in opts) { valid = false; break; }
    opts[key] = value;
  }
  const result = valid && opts['--workspace'] ? portableBootstrap(action, {
    workspace: opts['--workspace'], artifact: opts['--artifact'], sha: opts['--sha'],
  }) : envelope(ACTIONS.includes(action) ? action : 'doctor', null, 'UNAVAILABLE', 'INVALID_ARGUMENTS');
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'SUPPORTED_OFFLINE') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
