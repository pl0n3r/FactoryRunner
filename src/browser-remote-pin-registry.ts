import type { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import type { BrowserRemoteEntryHandle } from './browser-remote-entry-handle.ts';
import { stringValue } from './validation.ts';

export type BrowserRemotePin = Readonly<{
  binding_fingerprint: string;
  handle: BrowserRemoteEntryHandle;
  directory_entries: BrowserRemoteDirectory['entries'];
}>;

const SHA256_RE = /^[0-9a-f]{64}$/;

function fingerprint(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(label + ' inválido.');
  return parsed;
}

// Inspeccionar descriptores sin invocar getters sobre entradas programáticas.
// Admitir métodos de clase heredados que sean descriptores de datos.
function dataMember(input: object, name: string): unknown {
  let current: object | null = input;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(name + ' no admite accessors.');
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError(name + ' requerido.');
}

function pinRecord(input: BrowserRemotePin): BrowserRemotePin {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('BrowserRemotePin requerido.');
  }
  const bindingFingerprint = fingerprint(
    dataMember(input, 'binding_fingerprint'),
    'binding_fingerprint',
  );
  const handle = dataMember(input, 'handle');
  if (
    handle === null
    || typeof handle !== 'object'
    || typeof dataMember(handle, 'invoke') !== 'function'
    || typeof dataMember(handle, 'execute') !== 'function'
  ) {
    throw new TypeError('BrowserRemoteEntryHandle requerido.');
  }
  const directoryEntries = dataMember(input, 'directory_entries');
  if (typeof directoryEntries !== 'function') {
    throw new TypeError('Referencia BrowserRemoteDirectory.entries requerida.');
  }

  return Object.freeze({
    binding_fingerprint: bindingFingerprint,
    handle: handle as BrowserRemoteEntryHandle,
    directory_entries: directoryEntries as BrowserRemoteDirectory['entries'],
  });
}

export class BrowserRemotePinRegistry {
  readonly #byRequest = new Map<string, BrowserRemotePin>();

  pin(requestFingerprintInput: unknown, input: BrowserRemotePin): BrowserRemotePin {
    const requestFingerprint = fingerprint(
      requestFingerprintInput,
      'request_fingerprint',
    );
    const candidate = pinRecord(input);
    const existing = this.#byRequest.get(requestFingerprint);
    if (existing !== undefined) {
      if (
        existing.binding_fingerprint !== candidate.binding_fingerprint
        || existing.handle !== candidate.handle
        || existing.directory_entries !== candidate.directory_entries
      ) {
        throw new TypeError('Pin browser remoto existente cambió de identidad.');
      }
      return existing;
    }

    this.#byRequest.set(requestFingerprint, candidate);
    return candidate;
  }

  peek(requestFingerprintInput: unknown): BrowserRemotePin | null {
    const requestFingerprint = fingerprint(
      requestFingerprintInput,
      'request_fingerprint',
    );
    return this.#byRequest.get(requestFingerprint) ?? null;
  }

  take(requestFingerprintInput: unknown): BrowserRemotePin | null {
    const requestFingerprint = fingerprint(
      requestFingerprintInput,
      'request_fingerprint',
    );
    const pinned = this.#byRequest.get(requestFingerprint) ?? null;
    if (pinned !== null) this.#byRequest.delete(requestFingerprint);
    return pinned;
  }

  drop(requestFingerprintInput: unknown): void {
    const requestFingerprint = fingerprint(
      requestFingerprintInput,
      'request_fingerprint',
    );
    this.#byRequest.delete(requestFingerprint);
  }

  get size(): number {
    return this.#byRequest.size;
  }
}
