import type {
  ControlBotAckRequest,
  ControlBotEventsRequest,
  ControlBotHeartbeatRequest,
  ControlBotPollRequest,
  ControlBotTransport,
} from './transport.ts';
import {
  CONTROLBOT_ROUTES,
  parseControlBotConnectionProfile,
  type ControlBotConnectionProfile,
} from './connection-profile.ts';
import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
} from '../validation.ts';

export type ControlBotHttpRequest = {
  method: 'POST';
  url: string;
  credential_ref: string;
  timeout_ms: number;
  attempt: number;
  body: string;
};

export type ControlBotHttpResponse = {
  status: number;
  body: string | null;
};

export type ControlBotHttpExecutor = (
  request: ControlBotHttpRequest,
) => Promise<ControlBotHttpResponse>;

export type ControlBotHttpSleeper = (delayMs: number) => Promise<void>;

export class ControlBotHttpsTransportError extends Error {
  constructor(
    code:
      | 'controlbot_http_failed'
      | 'controlbot_http_response_invalid'
      | 'controlbot_http_sensitive_output',
  ) {
    super(code);
    this.name = 'ControlBotHttpsTransportError';
  }
}

type RouteKey = keyof typeof CONTROLBOT_ROUTES;

const RESPONSE_KEYS = ['status', 'body'] as const;
const SENSITIVE_RESPONSE_KEY_RE =
  /(?:^|[{"'\s,])(?:password|passwd|token|secret|cookie|authorization|private[_ -]?key|api[_ -]?key|dsn)["']?\s*[:=]/i;

function serializedPayload(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    throw new ControlBotHttpsTransportError('controlbot_http_failed');
  }
}

function responseBody(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 65_536) {
    throw new ControlBotHttpsTransportError('controlbot_http_response_invalid');
  }
  try {
    noSensitiveText(value, 'controlbot_response');
  } catch {
    throw new ControlBotHttpsTransportError('controlbot_http_sensitive_output');
  }
  if (SENSITIVE_RESPONSE_KEY_RE.test(value)) {
    throw new ControlBotHttpsTransportError('controlbot_http_sensitive_output');
  }
  return value;
}

function parseHttpResponse(input: unknown): ControlBotHttpResponse {
  let record;
  try {
    record = asRecord(input, 'ControlBotHttpResponse');
    exactKeys(record, RESPONSE_KEYS, 'ControlBotHttpResponse');
    return {
      status: integer(record.status, 'http.status', 100, 599),
      body: responseBody(record.body),
    };
  } catch (error) {
    if (error instanceof ControlBotHttpsTransportError) throw error;
    throw new ControlBotHttpsTransportError('controlbot_http_response_invalid');
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(
  profile: ControlBotConnectionProfile,
  failedAttempt: number,
): number {
  return Math.min(
    profile.backoff.initial_ms * 2 ** (failedAttempt - 1),
    profile.backoff.max_ms,
  );
}

function decodedJson(body: string | null): unknown {
  if (body === null || body.length === 0) {
    throw new ControlBotHttpsTransportError('controlbot_http_response_invalid');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ControlBotHttpsTransportError('controlbot_http_response_invalid');
  }
}

export class ControlBotHttpsTransport implements ControlBotTransport {
  readonly #profile: ControlBotConnectionProfile;
  readonly #executor: ControlBotHttpExecutor;
  readonly #sleep: ControlBotHttpSleeper;

  constructor(
    profileInput: unknown,
    executor: ControlBotHttpExecutor,
    sleep: ControlBotHttpSleeper,
  ) {
    this.#profile = parseControlBotConnectionProfile(profileInput);
    if (typeof executor !== 'function' || typeof sleep !== 'function') {
      throw new TypeError('Executor y sleeper de ControlBot son obligatorios.');
    }
    this.#executor = executor;
    this.#sleep = sleep;
  }

  async #post(route: RouteKey, payload: unknown): Promise<string | null> {
    const body = serializedPayload(payload);

    for (let attempt = 1; attempt <= this.#profile.backoff.max_attempts; attempt += 1) {
      let response: ControlBotHttpResponse;
      try {
        response = parseHttpResponse(
          await this.#executor({
            method: 'POST',
            url: this.#profile.origin + this.#profile.routes[route],
            credential_ref: this.#profile.credential_ref,
            timeout_ms: this.#profile.timeout_ms,
            attempt,
            body,
          }),
        );
      } catch (error) {
        if (error instanceof ControlBotHttpsTransportError) {
          if (error.message !== 'controlbot_http_failed') throw error;
        }
        if (attempt >= this.#profile.backoff.max_attempts) {
          throw new ControlBotHttpsTransportError('controlbot_http_failed');
        }
        await this.#sleep(retryDelay(this.#profile, attempt));
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        return response.body;
      }
      if (!retryableStatus(response.status) || attempt >= this.#profile.backoff.max_attempts) {
        throw new ControlBotHttpsTransportError('controlbot_http_failed');
      }
      await this.#sleep(retryDelay(this.#profile, attempt));
    }

    throw new ControlBotHttpsTransportError('controlbot_http_failed');
  }

  async poll(request: ControlBotPollRequest): Promise<unknown> {
    return decodedJson(await this.#post('poll', request));
  }

  async ack(request: ControlBotAckRequest): Promise<void> {
    await this.#post('ack', request);
  }

  async publishEvents(request: ControlBotEventsRequest): Promise<void> {
    await this.#post('events', request);
  }

  async publishHeartbeat(request: ControlBotHeartbeatRequest): Promise<void> {
    await this.#post('heartbeat', request);
  }
}
