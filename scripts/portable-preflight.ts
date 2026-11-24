/** Offline-only portability inventory. No runner, provider, daemon or network access. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release as kernelRelease } from 'node:os';
import { fileURLToPath } from 'node:url';

type Status = 'SUPPORTED_OFFLINE' | 'UNAVAILABLE' | 'UNKNOWN';
type Probe = 'present' | 'missing' | 'unknown';
export type PortableObservation = Readonly<{
  node_version: unknown;
  package_node_engine: unknown;
  platform: unknown;
  arch: unknown;
  kernel_release: unknown;
  git: Probe;
  docker: Probe;
}>;
export type PortableReport = Readonly<{
  schema_version: 1;
  scope: 'OFFLINE_ONLY';
  status: Status;
  authority: 'unchanged';
  node_major: number | null;
  platform: 'darwin' | 'linux' | 'win32' | 'unknown';
  arch: 'x64' | 'arm64' | 'unknown';
  requirements: { node_engine: '>=24' | 'UNKNOWN'; git: 'optional-adapter'; docker: 'optional'; wsl2: 'optional' };
  capabilities: ReadonlyArray<{ id: string; status: Status }>;
  limitations: readonly ['NO_LIVE_OR_RECOVERY_EVIDENCE', 'NO_OS_MATRIX_CERTIFICATION'];
  network_access: false;
  external_mutation: false;
}>;

const isStatus = (v: unknown): v is Probe => v === 'present' || v === 'missing' || v === 'unknown';
function toolStatus(value: unknown): Status {
  return value === 'present' ? 'SUPPORTED_OFFLINE' : value === 'missing' ? 'UNAVAILABLE' : 'UNKNOWN';
}
function safePlatform(value: unknown): PortableReport['platform'] {
  return value === 'linux' || value === 'darwin' || value === 'win32' ? value : 'unknown';
}
function safeArch(value: unknown): PortableReport['arch'] {
  return value === 'x64' || value === 'arm64' ? value : 'unknown';
}

/** Pure projection: raw command outputs, env values, paths and hostnames never enter reports. */
export function portablePreflight(value: PortableObservation): PortableReport {
  const major = typeof value.node_version === 'string' && /^v?\d+\.\d+\.\d+$/.test(value.node_version)
    ? Number(/^v?(\d+)/.exec(value.node_version)?.[1]) : NaN;
  const node_major = Number.isSafeInteger(major) && major > 0 ? major : null;
  const engine = value.package_node_engine === '>=24' ? '>=24' : 'UNKNOWN';
  const node: Status = engine !== '>=24' || node_major === null || node_major > 24
    ? 'UNKNOWN' : node_major === 24 ? 'SUPPORTED_OFFLINE' : 'UNAVAILABLE';
  const platform = safePlatform(value.platform);
  const arch = safeArch(value.arch);
  const host: Status = (platform === 'darwin' || platform === 'linux') && arch !== 'unknown'
    ? 'SUPPORTED_OFFLINE' : platform === 'unknown' || arch === 'unknown' ? 'UNKNOWN' : 'UNAVAILABLE';
  const git = toolStatus(isStatus(value.git) ? value.git : 'unknown');
  const docker = toolStatus(isStatus(value.docker) ? value.docker : 'unknown');
  // Only a running Linux kernel explicitly identifying WSL2 is evidence of WSL2.
  const wsl2: Status = platform === 'linux' && typeof value.kernel_release === 'string'
    && /(?:microsoft.*wsl2|wsl2.*microsoft)/i.test(value.kernel_release)
    ? 'SUPPORTED_OFFLINE' : platform === 'unknown' ? 'UNKNOWN' : 'UNAVAILABLE';
  const gitAdapter: Status = node === 'UNAVAILABLE' || git === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : node === 'SUPPORTED_OFFLINE' && git === 'SUPPORTED_OFFLINE' && host === 'SUPPORTED_OFFLINE'
      ? 'SUPPORTED_OFFLINE' : 'UNKNOWN';
  const status: Status = node === 'UNAVAILABLE' || host === 'UNAVAILABLE' ? 'UNAVAILABLE'
    : node === 'SUPPORTED_OFFLINE' && host === 'SUPPORTED_OFFLINE' && git === 'SUPPORTED_OFFLINE'
      ? 'SUPPORTED_OFFLINE' : 'UNKNOWN';
  return {
    schema_version: 1, scope: 'OFFLINE_ONLY', status, authority: 'unchanged', node_major,
    platform, arch,
    requirements: { node_engine: engine, git: 'optional-adapter', docker: 'optional', wsl2: 'optional' },
    capabilities: [
      { id: 'runtime.node24', status: node },
      { id: 'host.os-architecture', status: host },
      { id: 'tool.git-cli', status: git },
      { id: 'tool.docker-cli', status: docker },
      { id: 'tool.docker-daemon', status: 'UNKNOWN' },
      { id: 'host.wsl2-kernel', status: wsl2 },
      { id: 'adapter.git-read', status: gitAdapter },
      { id: 'adapter.programmatic', status: node === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN' },
      { id: 'adapter.browser-remote', status: 'UNKNOWN' },
      { id: 'adapter.recovery-remote', status: 'UNKNOWN' },
      { id: 'adapter.macos-only', status: platform === 'darwin' ? 'UNKNOWN' : 'UNAVAILABLE' },
    ],
    limitations: ['NO_LIVE_OR_RECOVERY_EVIDENCE', 'NO_OS_MATRIX_CERTIFICATION'],
    network_access: false, external_mutation: false,
  };
}

function probe(executable: string, args: string[], signature: RegExp): Probe {
  try {
    const result = spawnSync(executable, args, {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 1500, maxBuffer: 512,
      env: { PATH: process.env.PATH ?? '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing';
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return 'unknown';
    return signature.test(result.stdout.trim()) ? 'present' : 'unknown';
  } catch { return 'unknown'; }
}

/** Fixed local package.json only; an unreadable or changed requirement fails closed. */
export function observeLocal(): PortableObservation {
  let package_node_engine: unknown = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'engines' in parsed) {
      const e = parsed.engines;
      if (e && typeof e === 'object' && 'node' in e) package_node_engine = e.node;
    }
  } catch { /* No paths or raw errors in stdout/stderr. */ }
  return {
    node_version: process.version, package_node_engine, platform: process.platform,
    arch: process.arch, kernel_release: kernelRelease(),
    git: probe('git', ['--version'], /^git version \d+\.\d+(?:\.\d+)?(?:\s.*)?$/),
    docker: probe('docker', ['--version'], /^Docker version \d+\.\d+(?:\.\d+)?(?:,.*)?$/),
  };
}

const invoked = process.argv[1];
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  try {
    const report = portablePreflight(observeLocal());
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.status !== 'SUPPORTED_OFFLINE') process.exitCode = 1;
  } catch {
    process.stdout.write(JSON.stringify(portablePreflight({
      node_version: null, package_node_engine: null, platform: null, arch: null,
      kernel_release: null, git: 'unknown', docker: 'unknown',
    })) + '\n');
    process.exitCode = 1;
  }
}
