import { controlBotRunnerHttpRequest, type ControlBotRunnerHttpPath } from './http-protocol-v1.ts';
import { assertFencedAck, assertFencedEvent } from './fenced-execution-binding.ts';
import { HttpSessionAbortContract } from './http-session-abort.ts';
import { asRecord, exactKeys, integer, stableSha256, type JsonRecord } from '../validation.ts';

export type HttpSessionTransportRequest = Readonly<{
  version: 1;
  request_fingerprint: string;
  timeout_ms: number;
  envelope: Readonly<{
    version: 1;
    method: 'POST';
    path: ControlBotRunnerHttpPath;
    payload: Readonly<Record<string, unknown>>;
  }>;
}>;

export type HttpSessionTransportResponse = Readonly<{
  version: 1;
  request_fingerprint: string;
  status: number;
  body: Readonly<Record<string, unknown>>;
}>;

export type InjectedHttpSessionTransport = (
  request: HttpSessionTransportRequest,
  signal?: AbortSignal,
) => Promise<unknown>;

export type HttpSessionClientOptions = Readonly<{
  enabled?: boolean;
  test_mode?: boolean;
  timeout_ms?: number;
  max_response_bytes?: number;
  test_transport?: InjectedHttpSessionTransport;
}>;

export type HttpSessionRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type HttpSessionClientStatus = Readonly<{
  version: 1;
  enabled: boolean;
  transport_mode: 'disabled' | 'injected_test_only';
  timeout_ms: number;
  max_response_bytes: number;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

export type HttpSessionClientResult = Readonly<{
  version: 1;
  path: ControlBotRunnerHttpPath;
  status: number;
  request_fingerprint: string;
  response_fingerprint: string;
  body: Readonly<Record<string, unknown>>;
  transport_mode: 'injected_test_only';
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

export class HttpSessionClientError extends Error {
  readonly code: 'client_disabled' | 'transport_timeout' | 'transport_failed';

  constructor(code: 'client_disabled' | 'transport_timeout' | 'transport_failed') {
    super(code);
    this.name = 'HttpSessionClientError';
    this.code = code;
  }
}

export class HttpSessionAbortError extends Error {
  readonly code = 'transport_aborted' as const;

  constructor() {
    super('transport_aborted');
    this.name = 'HttpSessionAbortError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TIMEOUT_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const OPTION_KEYS = new Set([
  'enabled',
  'test_mode',
  'timeout_ms',
  'max_response_bytes',
  'test_transport',
]);
const REQUEST_OPTION_KEYS = new Set(['signal']);

const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function assertStrictResponseJson(root: JsonRecord, maxResponseBytes: number): void {
  // JSON.stringify silently drops undefined/functions/symbols and maps
  // NaN/Infinity to null. Never fingerprint a normalized non-JSON transport.
  // Inspect property descriptors to avoid calling accessor getters during
  // validation. Cycles remain denied by the serializer below.
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    if (++count > maxResponseBytes) throw new TypeError('body excede el límite JSON.');
    const value = pending.pop();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError('body contiene un número JSON inválido.');
      }
      continue;
    }
    if (typeof value !== 'object') throw new TypeError('body no es JSON estricto.');
    if (seen.has(value)) continue;
    seen.add(value);
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) {
      throw new TypeError('body contiene un objeto JSON no canónico.');
    }
    if ((proto !== null && Object.getOwnPropertyDescriptor(proto, 'toJSON'))
        || (array && Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'))) {
      throw new TypeError('body contiene toJSON heredado.');
    }
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) {
      throw new TypeError('body contiene un array incompleto.');
    }
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('body contiene clave Symbol.');
      if (array && key === 'length') continue;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc) || !desc.enumerable) {
        throw new TypeError('body contiene propiedades JSON no canónicas.');
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError('body contiene campos extra de array.');
      }
      pending.push(desc.value);
    }
  }
}

function snapshotResponseBody(input: JsonRecord, maxResponseBytes: number): JsonRecord {
  // Validate the transport as strict JSON before serializing the bounded,
  // detached tree. The response hash is calculated from this frozen snapshot.
  assertStrictResponseJson(input, maxResponseBytes);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new TypeError('body no es JSON-safe.');
  }
  if (typeof serialized !== 'string') throw new TypeError('body no es JSON-safe.');
  if (new TextEncoder().encode(serialized).byteLength > maxResponseBytes) {
    throw new TypeError('HttpSessionTransportResponse excede el límite de bytes.');
  }
  // JSON.parse creates a detached tree of ordinary JSON objects and arrays.
  // An explicit stack avoids recursive overflow on deeply nested input.
  const snapshot: unknown = JSON.parse(serialized);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('HttpSessionTransportResponse body inválido.');
  }
  const pending: object[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return snapshot as JsonRecord;
}

function assertAllowedOptions(options: HttpSessionClientOptions): void {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError('HttpSessionClientOptions contiene campos inválidos.');
  }
}

function requestSignal(optionsInput: HttpSessionRequestOptions): AbortSignal | undefined {
  const record = asRecord(optionsInput, 'HttpSessionRequestOptions');
  for (const key of Object.keys(record)) {
    if (!REQUEST_OPTION_KEYS.has(key)) {
      throw new TypeError('HttpSessionRequestOptions contiene campos inválidos.');
    }
  }
  return record.signal as AbortSignal | undefined;
}

function booleanOption(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} inválido.`);
  return value;
}

function boundedResponse(
  input: unknown,
  expectedRequestFingerprint: string,
  maxResponseBytes: number,
): HttpSessionTransportResponse {
  const record = asRecord(input, 'HttpSessionTransportResponse');
  exactKeys(record, ['version', 'request_fingerprint', 'status', 'body'], 'HttpSessionTransportResponse');
  // Require fixed own data properties and snapshot them exactly once.
  // Transport accessors must not change identity after validation.
  const fields = Object.getOwnPropertyDescriptors(record);
  for (const field of ['version', 'request_fingerprint', 'status', 'body'] as const) {
    const descriptor = fields[field];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('HttpSessionTransportResponse contiene accessor.');
    }
  }
  if (fields.version.value !== 1) throw new TypeError('HttpSessionTransportResponse version inválida.');
  const observedFingerprint: unknown = fields.request_fingerprint.value;
  if (
    typeof observedFingerprint !== 'string'
    || !HASH_RE.test(observedFingerprint)
    || observedFingerprint !== expectedRequestFingerprint
  ) {
    throw new TypeError('HttpSessionTransportResponse request_fingerprint inválido.');
  }
  const status = integer(fields.status.value, 'status', 200, 299);
  const body = asRecord(fields.body.value, 'body');
  const snapshot = snapshotResponseBody(body, maxResponseBytes);
  return Object.freeze({
    version: 1,
    request_fingerprint: observedFingerprint,
    status,
    body: snapshot,
  });
}

function canonicalEnvelope(
  path: ControlBotRunnerHttpPath,
  payloadInput: unknown,
): HttpSessionTransportRequest['envelope'] {
  const rawEnvelope = { version: 1, method: 'POST', path, payload: payloadInput };
  const validated = controlBotRunnerHttpRequest(rawEnvelope);
  return Object.freeze({
    version: 1,
    method: 'POST',
    path: validated.path,
    payload: validated.payload,
  });
}

function rawEnvelope(path: ControlBotRunnerHttpPath, payloadInput: unknown): JsonRecord {
  return { version: 1, method: 'POST', path, payload: payloadInput };
}

export class ControlBotHttpSessionClient {
  readonly #enabled: boolean;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #transport: InjectedHttpSessionTransport | null;

  constructor(options: HttpSessionClientOptions = {}) {
    assertAllowedOptions(options);
    const enabled = booleanOption(options.enabled, false, 'enabled');
    const testMode = booleanOption(options.test_mode, false, 'test_mode');
    const timeoutMs = integer(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, 'timeout_ms', 10, MAX_TIMEOUT_MS);
    const maxResponseBytes = integer(
      options.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'max_response_bytes',
      256,
      MAX_RESPONSE_BYTES,
    );
    if (!enabled) {
      if (testMode || options.test_transport !== undefined) {
        throw new TypeError('Cliente deshabilitado no acepta transport.');
      }
      this.#enabled = false;
      this.#transport = null;
    } else {
      if (!testMode || typeof options.test_transport !== 'function') {
        throw new TypeError('Cliente habilitado requiere transport inyectado en test_mode.');
      }
      this.#enabled = true;
      this.#transport = options.test_transport;
    }
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  status(): HttpSessionClientStatus {
    return Object.freeze({
      version: 1,
      enabled: this.#enabled,
      transport_mode: this.#enabled ? 'injected_test_only' : 'disabled',
      timeout_ms: this.#timeoutMs,
      max_response_bytes: this.#maxResponseBytes,
      ...SAFETY,
    });
  }

  heartbeat(payloadInput: unknown, options: HttpSessionRequestOptions = {}): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/heartbeat', payloadInput, undefined, options);
  }

  poll(payloadInput: unknown, options: HttpSessionRequestOptions = {}): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/poll', payloadInput, undefined, options);
  }

  ack(
    bindingInput: unknown,
    payloadInput: unknown,
    options: HttpSessionRequestOptions = {},
  ): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/ack', payloadInput, bindingInput, options);
  }

  event(
    bindingInput: unknown,
    payloadInput: unknown,
    options: HttpSessionRequestOptions = {},
  ): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/event', payloadInput, bindingInput, options);
  }

  async #send(
    path: ControlBotRunnerHttpPath,
    payloadInput: unknown,
    bindingInput: unknown,
    options: HttpSessionRequestOptions,
  ): Promise<HttpSessionClientResult> {
    if (!this.#enabled || this.#transport === null) {
      throw new HttpSessionClientError('client_disabled');
    }

    const raw = rawEnvelope(path, payloadInput);
    if (path === '/v1/runner/ack') {
      assertFencedAck(bindingInput, raw);
    } else if (path === '/v1/runner/event') {
      assertFencedEvent(bindingInput, raw);
    } else if (bindingInput !== undefined) {
      throw new TypeError('Binding solo permitido para ack/event.');
    }

    const envelope = canonicalEnvelope(path, payloadInput);
    const requestFingerprint = stableSha256(envelope);
    const callerSignal = requestSignal(options);
    const request = Object.freeze({
      version: 1 as const,
      request_fingerprint: requestFingerprint,
      timeout_ms: this.#timeoutMs,
      envelope,
    });

    const response = await this.#invoke(request, callerSignal);
    return Object.freeze({
      version: 1,
      path,
      status: response.status,
      request_fingerprint: requestFingerprint,
      response_fingerprint: stableSha256(response.body),
      body: response.body,
      transport_mode: 'injected_test_only',
      ...SAFETY,
    });
  }

  async #invoke(
    request: HttpSessionTransportRequest,
    callerSignal: AbortSignal | undefined,
  ): Promise<HttpSessionTransportResponse> {
    const transport = this.#transport;
    if (transport === null) throw new HttpSessionClientError('client_disabled');

    const abortContract = callerSignal === undefined
      ? null
      : new HttpSessionAbortContract({
          request_fingerprint: request.request_fingerprint,
          signal: callerSignal,
        });
    if (abortContract?.snapshot().abort_phase === 'pre_dispatch') {
      throw new HttpSessionAbortError();
    }

    const transportController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callerAbortHandler: (() => void) | undefined;
    let callerAbortSettled = false;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpSessionClientError('transport_timeout'));
        transportController.abort();
      }, this.#timeoutMs);
    });

    const callerAbort = callerSignal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          callerAbortHandler = () => {
            if (callerAbortSettled) return;
            callerAbortSettled = true;
            reject(new HttpSessionAbortError());
            transportController.abort();
          };
          callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
          if (abortContract?.snapshot().aborted === true) callerAbortHandler();
        });

    let raw: unknown;
    try {
      const transportPromise = transport(request, transportController.signal);
      raw = await Promise.race(
        callerAbort === null
          ? [transportPromise, timeout]
          : [transportPromise, timeout, callerAbort],
      );
    } catch (error) {
      if (
        error instanceof HttpSessionAbortError
        || (error instanceof HttpSessionClientError && error.code === 'transport_timeout')
      ) {
        throw error;
      }
      throw new HttpSessionClientError('transport_failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (callerSignal !== undefined && callerAbortHandler !== undefined) {
        callerSignal.removeEventListener('abort', callerAbortHandler);
      }
    }

    return boundedResponse(raw, request.request_fingerprint, this.#maxResponseBytes);
  }
}
