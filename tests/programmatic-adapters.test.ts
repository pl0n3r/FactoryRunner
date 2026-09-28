import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdapterRegistry,
  ExecFileCommandRunner,
  GitReadAdapter,
  ProgrammaticProcessError,
} from '../src/index.ts';
import type {
  CommandRunner,
  CommandSpec,
  ProgrammaticAdapter,
  ProgrammaticAdapterResult,
} from '../src/index.ts';

class FakeRunner implements CommandRunner {
  readonly specs: CommandSpec[] = [];
  readonly handler: (spec: CommandSpec) => string | Error;

  constructor(handler: (spec: CommandSpec) => string | Error) {
    this.handler = handler;
  }

  async run(spec: CommandSpec): Promise<{ stdout: string }> {
    this.specs.push(spec);
    const value = this.handler(spec);
    if (value instanceof Error) throw value;
    return { stdout: value };
  }
}

class FakeAdapter implements ProgrammaticAdapter {
  readonly calls: string[] = [];
  readonly id: string;
  readonly capabilities: readonly string[];

  constructor(id: string, capabilities: readonly string[]) {
    this.id = id;
    this.capabilities = capabilities;
  }

  async execute(capability: string): Promise<ProgrammaticAdapterResult> {
    this.calls.push(capability);
    return {
      capability,
      data: { ok: true },
      evidence: { code: 'fake-ok', summary: 'Fake adapter executed', ref: null },
    };
  }
}

test('AdapterRegistry dispatches exact capability and rejects collisions', async () => {
  const git = new FakeAdapter('git-a', ['git.head']);
  const registry = new AdapterRegistry([git]);
  assert.deepEqual(registry.capabilities(), ['git.head']);
  assert.equal((await registry.execute('git.head')).capability, 'git.head');
  assert.deepEqual(git.calls, ['git.head']);
  await assert.rejects(() => registry.execute('git.status'), /Capability sin adapter/);
  assert.throws(
    () => new AdapterRegistry([git, new FakeAdapter('git-b', ['git.head'])]),
    /más de un adapter/,
  );
});

test('ExecFileCommandRunner fails closed for executable and cwd before spawning', async () => {
  const runner = new ExecFileCommandRunner(['git']);
  await assert.rejects(
    () => runner.run({
      executable: 'sh',
      args: ['-c', 'echo unsafe'],
      cwd: process.cwd(),
      timeout_ms: 1_000,
      max_buffer: 8_192,
    }),
    /Ejecutable no permitido/,
  );
  await assert.rejects(
    () => runner.run({
      executable: 'git',
      args: ['status'],
      cwd: 'relative/path',
      timeout_ms: 1_000,
      max_buffer: 8_192,
    }),
    /cwd debe ser absoluto/,
  );
});

test('GitReadAdapter git.head uses fixed argv and validates stdout', async () => {
  const expected = 'a'.repeat(40);
  const runner = new FakeRunner(() => `${expected}\n`);
  const adapter = new GitReadAdapter(process.cwd(), runner);
  const result = await adapter.execute('git.head');

  assert.deepEqual(result.data, { sha: expected });
  assert.equal(result.evidence.ref, null);
  assert.deepEqual(runner.specs[0], {
    executable: 'git',
    args: ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'rev-parse', '--verify', 'HEAD'],
    cwd: process.cwd(),
    timeout_ms: 5_000,
    max_buffer: 65_536,
  });

  const invalid = new GitReadAdapter(process.cwd(), new FakeRunner(() => 'HEAD\n'));
  await assert.rejects(() => invalid.execute('git.head'), /git_head_invalid/);
});

test('GitReadAdapter git.status exposes only clean/count, never filenames', async () => {
  const raw = ' M src/token=supersecret.ts\nM  src/private-key.txt\n';
  const adapter = new GitReadAdapter(process.cwd(), new FakeRunner(() => raw));
  const result = await adapter.execute('git.status');
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.data, { clean: false, changed_tracked_files: 2 });
  assert.equal(serialized.includes('token=supersecret'), false);
  assert.equal(serialized.includes('private-key.txt'), false);
});

test('GitReadAdapter converts process failures to generic safe errors', async () => {
  const adapter = new GitReadAdapter(
    process.cwd(),
    new FakeRunner(() => new Error('stderr token=supersecretvalue')),
  );

  await assert.rejects(
    () => adapter.execute('git.head'),
    (error: unknown) => {
      assert.ok(error instanceof ProgrammaticProcessError);
      assert.equal(error.message, 'git_read_failed');
      assert.equal(error.message.includes('supersecretvalue'), false);
      return true;
    },
  );
});

test('GitReadAdapter executes real git.head against the CI checkout without network', async () => {
  const adapter = GitReadAdapter.create(process.cwd());
  const result = await adapter.execute('git.head');
  assert.equal(result.capability, 'git.head');
  assert.match(String(result.data.sha), /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
});

test('programmatic runner does not trust inherited PATH and git disables local fsmonitor helpers', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/adapters/programmatic.ts', import.meta.url), 'utf8')
  );
  const gitSource = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/adapters/git-read.ts', import.meta.url), 'utf8')
  );

  assert.equal(source.includes('process.env.PATH'), false);
  assert.equal(source.includes("'/usr/local/bin:/usr/bin:/bin'"), true);
  assert.equal(gitSource.includes("'core.fsmonitor=false'"), true);
  assert.equal(gitSource.includes("'core.untrackedCache=false'"), true);
});
