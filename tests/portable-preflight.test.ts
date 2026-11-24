import assert from 'node:assert/strict';
import test from 'node:test';
import { portablePreflight, type PortableObservation } from '../scripts/portable-preflight.ts';

const good: PortableObservation = {
  node_version: 'v24.11.0', package_node_engine: '>=24',
  platform: 'linux', arch: 'x64', kernel_release: '6.8.0-generic',
  git: 'present', docker: 'missing',
};
const inspect = (changes: Partial<PortableObservation> = {}) => portablePreflight({ ...good, ...changes });
const capability = (report: ReturnType<typeof inspect>, id: string) => report.capabilities.find((c) => c.id === id)?.status;

test('AC01: Node 24 Linux x64 offline report never asserts runtime or production readiness', () => {
  const result = inspect();
  assert.equal(result.status, 'SUPPORTED_OFFLINE');
  assert.equal(result.scope, 'OFFLINE_ONLY');
  assert.equal(result.authority, 'unchanged');
  assert.equal(result.node_major, 24);
  assert.equal(result.requirements.node_engine, '>=24');
  assert.equal(capability(result, 'adapter.git-read'), 'SUPPORTED_OFFLINE');
  assert.equal(capability(result, 'adapter.browser-remote'), 'UNKNOWN');
  assert.equal(capability(result, 'tool.docker-daemon'), 'UNKNOWN');
  assert.equal(result.network_access, false);
  assert.equal(result.external_mutation, false);
  assert.doesNotMatch(JSON.stringify(result), /\bREADY\b|VALIDATED_IN_PRODUCTION|DEPLOYED/);
});

test('AC02: unsupported Node, unknown future Node, engine drift and malformed versions fail closed', () => {
  assert.equal(capability(inspect({ node_version: 'v22.9.0' }), 'runtime.node24'), 'UNAVAILABLE');
  assert.equal(inspect({ node_version: 'v22.9.0' }).status, 'UNAVAILABLE');
  assert.equal(inspect({ node_version: 'v25.1.0' }).status, 'UNKNOWN');
  assert.equal(inspect({ package_node_engine: '>=18' }).status, 'UNKNOWN');
  assert.equal(inspect({ node_version: 'v24.0.0-evil' }).node_major, null);
  assert.equal(inspect({ node_version: 'v24.0.0-evil' }).status, 'UNKNOWN');
});

test('AC03: Git missing, ambiguous probes and Docker missing cannot be upgraded to READY', () => {
  const missing = inspect({ git: 'missing', docker: 'missing' });
  assert.equal(capability(missing, 'tool.git-cli'), 'UNAVAILABLE');
  assert.equal(capability(missing, 'adapter.git-read'), 'UNAVAILABLE');
  assert.equal(capability(missing, 'tool.docker-cli'), 'UNAVAILABLE');
  assert.notEqual(missing.status, 'SUPPORTED_OFFLINE');
  assert.equal(capability(inspect({ git: 'unknown' }), 'tool.git-cli'), 'UNKNOWN');
  assert.equal(capability(inspect({ docker: 'unknown' }), 'tool.docker-cli'), 'UNKNOWN');
  assert.equal(capability(inspect({ docker: 'present' }), 'tool.docker-daemon'), 'UNKNOWN');
});

test('AC03: WSL2 is never assumed from Windows, and macOS-only capabilities fail closed', () => {
  assert.equal(capability(inspect(), 'host.wsl2-kernel'), 'UNAVAILABLE');
  assert.equal(capability(inspect({ platform: 'win32', kernel_release: 'Windows 11' }), 'host.wsl2-kernel'), 'UNAVAILABLE');
  assert.equal(inspect({ platform: 'win32' }).status, 'UNAVAILABLE');
  assert.equal(capability(inspect({ kernel_release: '5.15.153-microsoft-standard-WSL2' }), 'host.wsl2-kernel'), 'SUPPORTED_OFFLINE');
  assert.equal(capability(inspect(), 'adapter.macos-only'), 'UNAVAILABLE');
  assert.equal(capability(inspect({ platform: 'darwin', arch: 'arm64' }), 'adapter.macos-only'), 'UNKNOWN');
  assert.equal(inspect({ platform: 'freebsd', arch: 'arm64' }).status, 'UNKNOWN');
  assert.equal(inspect({ platform: 'linux', arch: 's390x' }).status, 'UNKNOWN');
});

test('AC03: stdout contains only projected public enums, never raw inputs or secrets', () => {
  const sentinel = 'PRIVATE_USER@example.com /Users/private/.ssh/id_rsa TOKEN_123 host.internal';
  const result = inspect({
    node_version: sentinel, platform: sentinel, arch: sentinel,
    kernel_release: sentinel, package_node_engine: sentinel,
    git: sentinel as PortableObservation['git'], docker: sentinel as PortableObservation['docker'],
  });
  const stdout = JSON.stringify(result);
  for (const part of ['PRIVATE_USER', '/Users/', '.ssh', 'TOKEN_123', 'host.internal', 'example.com']) {
    assert.equal(stdout.includes(part), false, part);
  }
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.platform, 'unknown');
  assert.equal(result.arch, 'unknown');
  assert.deepEqual(result.capabilities.map((c) => c.id), [...new Set(result.capabilities.map((c) => c.id))]);
});

test('AC02/03: executable CLI smoke emits one sanitized JSON envelope, never child stderr', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const sentinel = 'DO_NOT_PRINT_PRIVATE_TOKEN_ABC';
  const cli = spawnSync(process.execPath, [
    '--experimental-strip-types',
    fileURLToPath(new URL('../scripts/portable-preflight.ts', import.meta.url)),
  ], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PORTABILITY_TEST_PRIVATE: sentinel },
  });
  assert.equal(cli.error, undefined);
  const rows = cli.stdout.trim().split('\n');
  assert.equal(rows.length, 1);
  const payload: unknown = JSON.parse(rows[0]!);
  assert.equal(typeof payload, 'object');
  assert.equal((payload as { scope: string }).scope, 'OFFLINE_ONLY');
  assert.equal((payload as { authority: string }).authority, 'unchanged');
  assert.doesNotMatch(cli.stdout + cli.stderr, /DO_NOT_PRINT_PRIVATE_TOKEN_ABC|\/Users\/|\/home\/runner\/|host\.internal/);
  if (process.versions.node.startsWith('24.')) assert.equal(cli.status, 0);
  else assert.equal(cli.status, 1);
});
