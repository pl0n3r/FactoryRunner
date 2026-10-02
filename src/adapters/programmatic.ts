import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { integer, slug, stringValue } from '../validation.ts';

const execFileAsync = promisify(execFile);
const TRUSTED_EXEC_PATH = '/usr/local/bin:/usr/bin:/bin';

export type ProgrammaticAdapterResult = {
  capability: string;
  data: Readonly<Record<string, string | number | boolean>>;
  evidence: {
    code: string;
    summary: string;
    ref: null;
  };
};

export interface ProgrammaticAdapter {
  readonly id: string;
  readonly capabilities: readonly string[];
  execute(capability: string): Promise<ProgrammaticAdapterResult>;
}

export type ProgrammaticAdapterRegistration = {
  adapter_id: string;
  capabilities: string[];
};

export type CommandSpec = {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeout_ms: number;
  max_buffer: number;
};

export type CommandResult = {
  stdout: string;
};

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

export class ProgrammaticProcessError extends Error {
  constructor(code = 'programmatic_process_failed') {
    super(code);
    this.name = 'ProgrammaticProcessError';
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  readonly #allowedExecutables: ReadonlySet<string>;

  constructor(allowedExecutables: readonly string[]) {
    if (!Array.isArray(allowedExecutables) || allowedExecutables.length === 0) {
      throw new TypeError('Allowlist de ejecutables vacía.');
    }

    const parsed = allowedExecutables.map((value) => slug(value, 'executable'));
    if (new Set(parsed).size !== parsed.length) {
      throw new TypeError('Allowlist de ejecutables duplicada.');
    }
    this.#allowedExecutables = new Set(parsed);
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    const executable = slug(spec.executable, 'executable');
    if (!this.#allowedExecutables.has(executable)) {
      throw new TypeError('Ejecutable no permitido.');
    }

    const cwd = stringValue(spec.cwd, 'cwd', 1024);
    if (!isAbsolute(cwd)) throw new TypeError('cwd debe ser absoluto.');

    if (!Array.isArray(spec.args) || spec.args.length > 32) {
      throw new TypeError('argv inválido.');
    }
    const args = spec.args.map((arg, index) => stringValue(arg, `argv[${index}]`, 512));
    const timeout = integer(spec.timeout_ms, 'timeout_ms', 100, 30_000);
    const maxBuffer = integer(spec.max_buffer, 'max_buffer', 1_024, 1_048_576);

    try {
      const result = await execFileAsync(executable, args, {
        cwd,
        timeout,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: {
          PATH: TRUSTED_EXEC_PATH,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          LC_ALL: 'C',
          LANG: 'C',
        },
      });
      if (typeof result.stdout !== 'string') throw new ProgrammaticProcessError();
      return { stdout: result.stdout };
    } catch {
      throw new ProgrammaticProcessError();
    }
  }
}

export class AdapterRegistry {
  readonly #byCapability = new Map<string, ProgrammaticAdapter>();
  readonly #registrations: ProgrammaticAdapterRegistration[] = [];

  constructor(adapters: readonly ProgrammaticAdapter[]) {
    if (!Array.isArray(adapters) || adapters.length === 0) {
      throw new TypeError('Registry de adapters vacío.');
    }

    const adapterIds = new Set<string>();
    for (const adapter of adapters) {
      const adapterId = slug(adapter.id, 'adapter.id');
      if (adapterIds.has(adapterId)) throw new TypeError('Adapter id duplicado.');
      adapterIds.add(adapterId);

      if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
        throw new TypeError('Adapter sin capabilities.');
      }

      const capabilities = adapter.capabilities.map((value: unknown) => slug(value, 'capability'));
      if (new Set(capabilities).size !== capabilities.length) {
        throw new TypeError('Adapter contiene capabilities duplicadas.');
      }

      for (const capability of capabilities) {
        if (this.#byCapability.has(capability)) {
          throw new TypeError('Capability registrada por más de un adapter.');
        }
        this.#byCapability.set(capability, adapter);
      }

      capabilities.sort((a: string, b: string) => a.localeCompare(b, 'en'));
      this.#registrations.push({ adapter_id: adapterId, capabilities });
    }

    this.#registrations.sort((a: ProgrammaticAdapterRegistration, b: ProgrammaticAdapterRegistration) =>
      a.adapter_id.localeCompare(b.adapter_id, 'en'));
  }

  registrations(): ProgrammaticAdapterRegistration[] {
    return this.#registrations.map((registration) => ({
      adapter_id: registration.adapter_id,
      capabilities: [...registration.capabilities],
    }));
  }

  capabilities(): string[] {
    return [...this.#byCapability.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  }

  async execute(capabilityInput: string): Promise<ProgrammaticAdapterResult> {
    const capability = slug(capabilityInput, 'capability');
    const adapter = this.#byCapability.get(capability);
    if (!adapter) throw new TypeError('Capability sin adapter programático.');

    const result = await adapter.execute(capability);
    if (result.capability !== capability) {
      throw new TypeError('Adapter devolvió capability inconsistente.');
    }
    return result;
  }
}
