import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portableBootstrap } from '../scripts/portable-bootstrap.ts';
import { portablePreflight } from '../scripts/portable-preflight.ts';

const good = portablePreflight({ node_version: 'v24.11.0', package_node_engine: '>=24',
  platform: 'linux', arch: 'x64', kernel_release: '6.8', git: 'present', docker: 'missing' });
function sandbox(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'factoryrunner-offline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'runner');
  const releases = join(root, 'releases');
  mkdirSync(releases);
  function asset(version: string) {
    const artifact = join(releases, `release-${version}.json`);
    const raw = JSON.stringify({ schema_version: 1, kind: 'OFFLINE_FIXTURE', version });
    writeFileSync(artifact, raw);
    return { artifact, sha: createHash('sha256').update(raw).digest('hex') };
  }
  return { root, workspace, releases, asset };
}

test('AC-01: reject home/git/non-temporary/traversal and symlinked workspaces before writing', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0');
  for (const workspace of [homedir(), process.cwd(), join(x.root, '..', 'runner'), join(x.root, 'other'),
    x.root + '/runner/../runner']) {
    assert.equal(portableBootstrap('install', { workspace, ...a }, good).reason, 'UNSAFE_WORKSPACE');
  }
  assert.equal(existsSync(x.workspace), false);
  if (process.platform !== 'win32') {
    chmodSync(x.root, 0o755);
    assert.equal(portableBootstrap('install', { workspace: x.workspace, ...a }, good).reason, 'UNSAFE_WORKSPACE');
    chmodSync(x.root, 0o700);
  }
  symlinkSync(x.releases, x.workspace);
  assert.equal(portableBootstrap('install', { workspace: x.workspace, ...a }, good).reason, 'UNSAFE_WORKSPACE');
  assert.equal(existsSync(join(x.releases, 'state.json')), false);
});

test('AC-02: install/start/stop/status are idempotent, synthetic, and leave no daemon or transport', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0'), opts = { workspace: x.workspace, ...a };
  assert.equal(portableBootstrap('status', opts, good).reason, 'NOT_INSTALLED');
  for (let i = 0; i < 2; i++) {
    const result = portableBootstrap('install', opts, good);
    assert.equal(result.status, 'SUPPORTED_OFFLINE');
    assert.equal(result.phase, 'STOPPED');
    assert.equal(result.artifact_sha256, a.sha);
  }
  for (let i = 0; i < 2; i++) {
    const active = portableBootstrap('start', opts, good);
    assert.equal(active.phase, 'SIMULATED_ACTIVE');
    assert.equal(active.network_access, false);
    assert.equal(active.production_execution, false);
    assert.equal(active.authority, 'unchanged');
    assert.doesNotMatch(JSON.stringify(active), /\bREADY\b|VALIDATED_IN_PRODUCTION/);
  }
  assert.equal(portableBootstrap('status', opts, good).phase, 'SIMULATED_ACTIVE');
  for (let i = 0; i < 2; i++) assert.equal(portableBootstrap('stop', opts, good).phase, 'STOPPED');
  assert.equal(JSON.parse(readFileSync(join(x.workspace, 'state.json'), 'utf8')).release.sha, a.sha);
  assert.equal(existsSync(join(x.workspace, 'operation.lock')), false);
});

test('AC-02/03: exact SHA, controlled update, rollback, version drift and offline retries', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0'), b = x.asset('1.0.1');
  const opts = (a: ReturnType<typeof x.asset>) => ({ workspace: x.workspace, ...a });
  assert.equal(portableBootstrap('install', opts(a), good).version, '1.0.0');
  assert.equal(portableBootstrap('start', opts(a), good).phase, 'SIMULATED_ACTIVE');
  assert.equal(portableBootstrap('update', opts(b), good).reason, 'STOP_REQUIRED');
  portableBootstrap('stop', opts(a), good);
  for (let i = 0; i < 2; i++) assert.equal(portableBootstrap('update', opts(b), good).version, '1.0.1');
  const drift = x.asset('1.0.1');
  writeFileSync(drift.artifact, JSON.stringify({ schema_version: 1, kind: 'OFFLINE_FIXTURE', version: '1.0.1' }) + '\n');
  drift.sha = createHash('sha256').update(readFileSync(drift.artifact)).digest('hex');
  assert.equal(portableBootstrap('update', opts(drift), good).reason, 'ARTIFACT_SHA_MISMATCH');
  // Recreate the original exact-SHA fixture before rollback; corrupt current releases fail closed.
  x.asset('1.0.1');
  assert.equal(portableBootstrap('rollback', opts(b), good).version, '1.0.0');
  assert.equal(portableBootstrap('rollback', opts(b), good).reason, 'NO_ROLLBACK');
  const incompatible = x.asset('2.0.0');
  assert.equal(portableBootstrap('update', opts(incompatible), good).reason, 'VERSION_INCOMPATIBLE');
  assert.equal(portableBootstrap('status', opts(a), good).artifact_sha256, a.sha);
});

test('AC-03: missing/corrupt assets, invalid identity and symlinked manifests reject without modifying state', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0');
  assert.equal(portableBootstrap('install', { workspace: x.workspace, artifact: a.artifact, sha: 'a'.repeat(64) }, good).reason, 'ARTIFACT_SHA_MISMATCH');
  assert.equal(portableBootstrap('install', { workspace: x.workspace, artifact: join(x.releases, 'release-missing.json'), sha: a.sha }, good).reason, 'INVALID_ARTIFACT');
  const oversized = join(x.releases, 'release-oversized.json');
  const huge = 'X'.repeat(2048);
  writeFileSync(oversized, huge);
  assert.equal(portableBootstrap('install', { workspace: x.workspace, artifact: oversized,
    sha: createHash('sha256').update(huge).digest('hex') }, good).reason, 'INVALID_ARTIFACT');
  const extremeVersion = x.asset('9999999999.0.0');
  assert.equal(portableBootstrap('install', { workspace: x.workspace, ...extremeVersion }, good).reason, 'INVALID_ARTIFACT');
  assert.equal(existsSync(x.workspace), false);
  const linked = join(x.releases, 'release-link.json');
  symlinkSync(a.artifact, linked);
  assert.equal(portableBootstrap('install', { workspace: x.workspace, artifact: linked, sha: a.sha }, good).reason, 'INVALID_ARTIFACT');
  assert.equal(portableBootstrap('install', { workspace: x.workspace, ...a }, good).status, 'SUPPORTED_OFFLINE');
  writeFileSync(join(x.workspace, 'operation.lock'), 'held');
  assert.equal(portableBootstrap('stop', { workspace: x.workspace }, good).reason, 'WORKSPACE_BUSY');
  rmSync(join(x.workspace, 'operation.lock'));
  const corrupt = join(x.workspace, 'state.json');
  writeFileSync(corrupt, '{"token":"DO_NOT_LOG"}');
  const result = portableBootstrap('status', { workspace: x.workspace }, good);
  assert.equal(result.reason, 'INVALID_STATE');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LOG|\/home\/|\/Users\//);
});

test('AC-03: a missing/corrupt artifact cannot be used for status, start or rollback', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0'), b = x.asset('1.0.1');
  const opts = { workspace: x.workspace, ...a };
  assert.equal(portableBootstrap('install', opts, good).status, 'SUPPORTED_OFFLINE');
  rmSync(a.artifact);
  assert.equal(portableBootstrap('status', opts, good).reason, 'INVALID_ARTIFACT');
  assert.equal(portableBootstrap('start', opts, good).reason, 'INVALID_ARTIFACT');
  x.asset('1.0.0');
  assert.equal(portableBootstrap('update', { workspace: x.workspace, ...b }, good).version, '1.0.1');
  rmSync(a.artifact);
  assert.equal(portableBootstrap('rollback', { workspace: x.workspace }, good).reason, 'INVALID_ARTIFACT');
  assert.equal(portableBootstrap('status', { workspace: x.workspace }, good).version, '1.0.1');
  rmSync(b.artifact);
  assert.equal(portableBootstrap('rollback', { workspace: x.workspace }, good).reason, 'INVALID_ARTIFACT');
  const c = x.asset('1.0.2');
  assert.equal(portableBootstrap('update', { workspace: x.workspace, ...c }, good).reason, 'INVALID_ARTIFACT');
  assert.equal(portableBootstrap('status', { workspace: x.workspace }, good).reason, 'INVALID_ARTIFACT');
});

test('AC-03: negative Node, architecture and unverified WSL2/Docker are fail-closed', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0');
  const opts = { workspace: x.workspace, ...a };
  const observed = (node: string, arch: string, platform = 'linux') => portablePreflight({
    node_version: node, package_node_engine: '>=24', platform, arch, kernel_release: 'unknown', git: 'present', docker: 'missing',
  });
  assert.equal(portableBootstrap('install', opts, observed('v22.0.0', 'x64')).status, 'UNAVAILABLE');
  assert.equal(portableBootstrap('install', opts, observed('v24.0.0', 's390x')).status, 'UNKNOWN');
  assert.equal(portableBootstrap('install', opts, observed('v24.0.0', 'x64', 'win32')).status, 'UNAVAILABLE');
  assert.equal(existsSync(x.workspace), false);
  assert.equal(portableBootstrap('doctor', opts, good).status, 'SUPPORTED_OFFLINE');
});

test('AC-02/03: CLI emits one sanitized JSON and never starts a service', (t) => {
  const x = sandbox(t), a = x.asset('1.0.0'), secret = 'TOP_SECRET_LOCAL_TOKEN_XYZ';
  const result = spawnSync(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('../scripts/portable-bootstrap.ts', import.meta.url)),
    'install', '--workspace', x.workspace, '--artifact', a.artifact, '--sha', a.sha],
  { encoding: 'utf8', timeout: 10_000, env: { ...process.env, SECRET_SENTINEL: secret } });
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scope, 'OFFLINE_ONLY');
  assert.equal(payload.network_access, false);
  assert.equal(payload.production_execution, false);
  assert.doesNotMatch(result.stdout + result.stderr, /TOP_SECRET_LOCAL_TOKEN_XYZ|VALIDATED_IN_PRODUCTION|\bREADY\b/);
  assert.equal(payload.status === 'SUPPORTED_OFFLINE', result.status === 0);
});
