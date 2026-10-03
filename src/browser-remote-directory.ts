import {
  browserRemoteProfile,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import type { BrowserRemoteTransport } from './browser-remote-driver.ts';
import {
  asRecord,
  exactKeys,
  stringValue,
} from './validation.ts';

export type BrowserRemoteDirectoryEntry = Readonly<{
  profile: BrowserRemoteProfile;
  transport: BrowserRemoteTransport;
}>;

const PROFILE_KEYS = [
  'version',
  'authority',
  'runner_id',
  'location',
  'capability',
  'remote_alias',
  'fingerprint',
] as const;

const OPAQUE_ALIAS_RE = /^[a-z][a-z0-9-]{0,63}$/;

function canonicalProfile(value: unknown): BrowserRemoteProfile {
  const record = asRecord(value, 'BrowserRemoteProfile');
  exactKeys(record, PROFILE_KEYS, 'BrowserRemoteProfile');

  const canonical = browserRemoteProfile({
    version: record.version,
    runner_id: record.runner_id,
    location: record.location,
    capability: record.capability,
    remote_alias: record.remote_alias,
  });

  if (
    record.authority !== canonical.authority
    || record.fingerprint !== canonical.fingerprint
  ) {
    throw new TypeError('BrowserRemoteProfile no es canónico.');
  }

  return canonical;
}

function sealedTransport(value: unknown): BrowserRemoteTransport {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }

  const transport = value as BrowserRemoteTransport;
  const execute = transport.execute;
  if (typeof execute !== 'function') {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }

  const descriptor = Object.getOwnPropertyDescriptor(transport, 'execute');
  const enumerable = descriptor?.enumerable ?? false;
  try {
    Object.defineProperty(transport, 'execute', {
      value: execute,
      writable: false,
      configurable: false,
      enumerable,
    });
  } catch {
    throw new TypeError('BrowserRemoteTransport no puede sellarse.');
  }

  return transport;
}

function opaqueAlias(value: unknown): string {
  const parsed = stringValue(value, 'remote_alias', 64);
  if (!OPAQUE_ALIAS_RE.test(parsed)) {
    throw new TypeError('remote_alias debe ser opaco y provider-neutral.');
  }
  return parsed;
}

export class BrowserRemoteDirectory {
  readonly #byAlias = new Map<string, BrowserRemoteDirectoryEntry>();

  register(input: unknown): BrowserRemoteDirectoryEntry {
    const record = asRecord(input, 'BrowserRemoteDirectoryRegistration');
    exactKeys(
      record,
      ['profile', 'transport'],
      'BrowserRemoteDirectoryRegistration',
    );

    const profile = canonicalProfile(record.profile);
    const transport = sealedTransport(record.transport);

    if (this.#byAlias.has(profile.remote_alias)) {
      throw new TypeError('remote_alias browser remoto duplicado.');
    }

    const entry = Object.freeze({ profile, transport });
    this.#byAlias.set(profile.remote_alias, entry);
    return entry;
  }

  get size(): number {
    return this.#byAlias.size;
  }

  remove(remoteAlias: unknown, expectedFingerprint: unknown): boolean {
    const alias = opaqueAlias(remoteAlias);
    const fingerprint = stringValue(expectedFingerprint, 'expected_fingerprint', 64);
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new TypeError('expected_fingerprint browser remoto inválido.');
    }

    const entry = this.#byAlias.get(alias);
    if (entry === undefined) return false;
    if (entry.profile.fingerprint !== fingerprint) {
      throw new TypeError('Fingerprint browser remoto no coincide.');
    }

    return this.#byAlias.delete(alias);
  }

  lookup(remoteAlias: unknown): BrowserRemoteDirectoryEntry | null {
    const alias = opaqueAlias(remoteAlias);
    return this.#byAlias.get(alias) ?? null;
  }

  entries(): readonly BrowserRemoteDirectoryEntry[] {
    return Object.freeze([...this.#byAlias.values()]);
  }
}
