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

function pinRecord(input: BrowserRemotePin): BrowserRemotePin {
  const bindingFingerprint = fingerprint(
    input.binding_fingerprint,
    'binding_fingerprint',
  );
  if (
    input.handle === null
    || typeof input.handle !== 'object'
    || typeof input.handle.invoke !== 'function'
    || typeof input.handle.execute !== 'function'
  ) {
    throw new TypeError('BrowserRemoteEntryHandle requerido.');
  }
  if (typeof input.directory_entries !== 'function') {
    throw new TypeError('Referencia BrowserRemoteDirectory.entries requerida.');
  }

  return Object.freeze({
    binding_fingerprint: bindingFingerprint,
    handle: input.handle,
    directory_entries: input.directory_entries,
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
