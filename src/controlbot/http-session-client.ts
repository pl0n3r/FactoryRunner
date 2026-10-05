import { controlBotRunnerHttpRequest, type ControlBotRunnerHttpPath } from './http-protocol-v1.ts';
import {
  assertFencedAck,
  assertFencedEvent,
} from './fenced-execution-binding.ts';
import {
  asRecord,
  exactKeys,
  integer,
  stableSha256,
  type JsonRecord,
} from '../validation.ts';

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
) => Promise<unknown>;

export type HttpSessionClientOptions = Readonly<{
  enabled?: boolean;
  test_mode?: boolean;
  timeout_ms?: number;
  max_response_bytes?: number;
  test_transport?: InjectedHttpSessionTransport;
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

const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function jsonBytes(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} no es JSON-safe.`);
  }
  if (serialized === undefined) throw new TypeError(`${label} no es JSON-safe.`);
  return new TextEncoder().encode(serialized).byteLength;
}

function assertAllowedOptions(options: HttpSessionClientOptions): void {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError('HttpSessionClientOptions contiene campos inválidos.');
  }
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
  if (record.version !== 1) throw new TypeError('HttpSessionTransportResponse version inválida.');

  if (
    typeof record.request_fingerprint !== 'string'
    || !HASH_RE.test(record.request_fingerprint)
    || record.request_fingerprint !== expectedRequestFingerprint
  ) {
    throw new TypeError('HttpSessionTransportResponse request_fingerprint inválido.');
  }

  const status = integer(record.status, 'status', 200, 299);
  const body = asRecord(record.body, 'body');
  if (jsonBytes(body, 'body') > maxResponseBytes) {
    throw new TypeError('HttpSessionTransportResponse excede el límite de bytes.');
  }

  return Object.freeze({
    version: 1,
    request_fingerprint: record.request_fingerprint,
    status,
    body: Object.freeze({ ...body }),
  });
}

function canonicalEnvelope(
  path: ControlBotRunnerHttpPath,
  payloadInput: unknown,
): HttpSessionTransportRequest['envelope'] {
  const rawEnvelope = {
    version: 1,
    method: 'POST',
    path,
    payload: payloadInput,
  };
  const validated = controlBotRunnerHttpRequest(rawEnvelope);
  return Object.freeze({
    version: 1,
    method: 'POST',
    path: validated.path,
    payload: validated.payload,
  });
}

function rawEnvelope(path: ControlBotRunnerHttpPath, payloadInput: unknown): JsonRecord {
  return {
    version: 1,
    method: 'POST',
    path,
    payload: payloadInput,
  };
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

  heartbeat(payloadInput: unknown): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/heartbeat', payloadInput);
  }

  poll(payloadInput: unknown): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/poll', payloadInput);
  }

  ack(bindingInput: unknown, payloadInput: unknown): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/ack', payloadInput, bindingInput);
  }

  event(bindingInput: unknown, payloadInput: unknown): Promise<HttpSessionClientResult> {
    return this.#send('/v1/runner/event', payloadInput, bindingInput);
  }

  async #send(
    path: ControlBotRunnerHttpPath,
    payloadInput: unknown,
    bindingInput?: unknown,
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
    const request = Object.freeze({
      version: 1 as const,
      request_fingerprint: requestFingerprint,
      timeout_ms: this.#timeoutMs,
      envelope,
    });

    const response = await this.#invoke(request);
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

  async #invoke(request: HttpSessionTransportRequest): Promise<HttpSessionTransportResponse> {
    const transport = this.#transport;
    if (transport === null) throw new HttpSessionClientError('client_disabled');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpSessionClientError('transport_timeout')), this.#timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([transport(request), timeout]);
    } catch (error) {
      if (error instanceof HttpSessionClientError && error.code === 'transport_timeout') throw error;
      throw new HttpSessionClientError('transport_failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    return boundedResponse(raw, request.request_fingerprint, this.#maxResponseBytes);
  }
}
