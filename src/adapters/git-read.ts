import { isAbsolute } from 'node:path';
import {
  ExecFileCommandRunner,
  type CommandRunner,
  type ProgrammaticAdapter,
  type ProgrammaticAdapterResult,
  ProgrammaticProcessError,
} from './programmatic.ts';
import { stringValue } from '../validation.ts';

const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export class GitReadAdapter implements ProgrammaticAdapter {
  readonly id = 'git-read';
  readonly capabilities = ['git.head', 'git.status'] as const;
  readonly #repoRoot: string;
  readonly #runner: CommandRunner;

  constructor(repoRoot: string, runner: CommandRunner) {
    const parsedRoot = stringValue(repoRoot, 'repoRoot', 1024);
    if (!isAbsolute(parsedRoot)) throw new TypeError('repoRoot debe ser absoluto.');
    this.#repoRoot = parsedRoot;
    this.#runner = runner;
  }

  static create(repoRoot: string): GitReadAdapter {
    return new GitReadAdapter(repoRoot, new ExecFileCommandRunner(['git']));
  }

  async execute(capability: string): Promise<ProgrammaticAdapterResult> {
    if (capability === 'git.head') return this.#head();
    if (capability === 'git.status') return this.#status();
    throw new TypeError('Capability no soportada por GitReadAdapter.');
  }

  async #runGit(args: readonly string[]): Promise<string> {
    const hardenedArgs = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      ...args,
    ];

    try {
      const result = await this.#runner.run({
        executable: 'git',
        args: hardenedArgs,
        cwd: this.#repoRoot,
        timeout_ms: 5_000,
        max_buffer: 65_536,
      });
      return result.stdout;
    } catch {
      throw new ProgrammaticProcessError('git_read_failed');
    }
  }

  async #head(): Promise<ProgrammaticAdapterResult> {
    const stdout = await this.#runGit(['rev-parse', '--verify', 'HEAD']);
    const sha = stdout.trim();
    if (!GIT_SHA_RE.test(sha)) {
      throw new ProgrammaticProcessError('git_head_invalid');
    }

    return {
      capability: 'git.head',
      data: { sha: sha.toLowerCase() },
      evidence: {
        code: 'git-head',
        summary: 'Git HEAD verified',
        ref: null,
      },
    };
  }

  async #status(): Promise<ProgrammaticAdapterResult> {
    const stdout = await this.#runGit(['status', '--porcelain=v1', '--untracked-files=no']);
    const changed = stdout.split(/\r?\n/u).filter((line) => line.length > 0).length;

    return {
      capability: 'git.status',
      data: {
        clean: changed === 0,
        changed_tracked_files: changed,
      },
      evidence: {
        code: 'git-status',
        summary: 'Tracked Git status counted',
        ref: null,
      },
    };
  }
}
