import { asRecord, exactKeys } from '../validation.ts';

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_SNAPSHOT_BYTES = 1_024;
const INPUT_FIELDS = Object.freeze(['request_fingerprint', 'signal']);
const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

export type HttpSessionAbortPhase = 'none' | 'pre_dispatch' | 'in_flight';

export type HttpSessionAbortSnapshot = Readonly<{
  version: 2;
  request_fingerprint: string;
  aborted: boolean;
  abort_phase: HttpSessionAbortPhase;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

function requestFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new TypeError('request_fingerprint inválido.');
  }
  return value;
}

function signalAborted(value: unknown): { signal: AbortSignal; aborted: boolean } {
  if (typeof abortedGetter !== 'function') {
    throw new TypeError('AbortSignal no disponible.');
  }

  let aborted: unknown;
  try {
    aborted = abortedGetter.call(value);
  } catch {
    throw new TypeError('signal debe ser AbortSignal.');
  }

  if (typeof aborted !== 'boolean') {
    throw new TypeError('signal debe ser AbortSignal.');
  }

  return {
    signal: value as AbortSignal,
    aborted,
  };
}

function boundedSnapshot(
  requestFingerprintValue: string,
  aborted: boolean,
  abortPhase: HttpSessionAbortPhase,
): HttpSessionAbortSnapshot {
  const snapshot = Object.freeze({
    version: 2 as const,
    request_fingerprint: requestFingerprintValue,
    aborted,
    abort_phase: abortPhase,
    ...SAFETY,
  });

  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new TypeError('HttpSessionAbortSnapshot excede el límite de bytes.');
  }
  return snapshot;
}

export class HttpSessionAbortContract {
  readonly #requestFingerprint: string;
  readonly #signal: AbortSignal;
  readonly #preAborted: boolean;

  constructor(input: unknown) {
    const record = asRecord(input, 'HttpSessionAbortContract');
    exactKeys(record, INPUT_FIELDS, 'HttpSessionAbortContract');

    const requestFingerprintInput = record.request_fingerprint;
    const signalInput = record.signal;

    this.#requestFingerprint = requestFingerprint(requestFingerprintInput);
    const capturedSignal = signalAborted(signalInput);
    this.#signal = capturedSignal.signal;
    this.#preAborted = capturedSignal.aborted;

    Object.freeze(this);
  }

  snapshot(): HttpSessionAbortSnapshot {
    if (this.#preAborted) {
      return boundedSnapshot(this.#requestFingerprint, true, 'pre_dispatch');
    }

    const current = signalAborted(this.#signal);
    if (current.aborted) {
      return boundedSnapshot(this.#requestFingerprint, true, 'in_flight');
    }

    return boundedSnapshot(this.#requestFingerprint, false, 'none');
  }
}
