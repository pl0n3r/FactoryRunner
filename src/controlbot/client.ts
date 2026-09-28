import {
  assertIdempotentOrder,
  assertOrderExecutable,
  orderFingerprint,
  parseExecutionOrder,
  type ExecutionOrder,
} from '../order.ts';
import { parseExecutionEvent, type ExecutionEvent } from '../event.ts';
import {
  assertHeartbeatMatchesIdentity,
  parseRunnerHeartbeat,
  parseRunnerIdentity,
  type RunnerHeartbeat,
  type RunnerIdentity,
} from '../runner.ts';
import { asRecord, exactKeys, integer, ref } from '../validation.ts';
import type {
  ControlBotAckRequest,
  ControlBotEventsRequest,
  ControlBotHeartbeatRequest,
  ControlBotPollRequest,
  ControlBotTransport,
} from './transport.ts';

export class ControlBotClientError extends Error {
  constructor(code: 'controlbot_transport_failed' | 'controlbot_protocol_invalid') {
    super(code);
    this.name = 'ControlBotClientError';
  }
}

export type ControlBotPollResult = {
  cursor: string | null;
  orders: ExecutionOrder[];
};

function parseCursor(input: unknown): string | null {
  if (input === null) return null;
  const parsed = ref(input, 'cursor', 180);
  if (!parsed.startsWith('controlbotcursor:')) {
    throw new TypeError('Cursor de ControlBot inválido.');
  }
  return parsed;
}

export class ControlBotClient {
  readonly #identity: RunnerIdentity;
  readonly #transport: ControlBotTransport;
  readonly #validatedOrders = new Map<string, { fingerprint: string; order: ExecutionOrder }>();

  constructor(identity: RunnerIdentity, transport: ControlBotTransport) {
    this.#identity = parseRunnerIdentity(identity);
    this.#transport = transport;
  }

  async poll(cursor: string | null, limit: number, now: number): Promise<ControlBotPollResult> {
    const parsedCursor = parseCursor(cursor);
    const parsedLimit = integer(limit, 'limit', 1, 64);
    integer(now, 'now');

    const request: ControlBotPollRequest = {
      version: 1,
      runner_id: this.#identity.runner_id,
      capabilities: [...this.#identity.capabilities],
      cursor: parsedCursor,
      limit: parsedLimit,
    };

    let raw: unknown;
    try {
      raw = await this.#transport.poll(request);
    } catch {
      throw new ControlBotClientError('controlbot_transport_failed');
    }

    let response;
    try {
      response = asRecord(raw, 'ControlBotPollResponse');
      exactKeys(response, ['version', 'cursor', 'orders'], 'ControlBotPollResponse');
      if (response.version !== 1 || !Array.isArray(response.orders) || response.orders.length > parsedLimit) {
        throw new TypeError('Respuesta poll inválida.');
      }
    } catch {
      throw new ControlBotClientError('controlbot_protocol_invalid');
    }

    const orders: ExecutionOrder[] = [];
    const batch = new Map<string, ExecutionOrder>();
    try {
      for (const rawOrder of response.orders) {
        const order = parseExecutionOrder(rawOrder);
        assertOrderExecutable(order, this.#identity, now);
        const existing = batch.get(order.order_id);
        if (existing) {
          assertIdempotentOrder(existing, order);
          continue;
        }
        batch.set(order.order_id, order);
        orders.push(order);
        this.#validatedOrders.set(order.order_id, {
          fingerprint: orderFingerprint(order),
          order,
        });
      }
      return {
        cursor: parseCursor(response.cursor),
        orders,
      };
    } catch {
      throw new ControlBotClientError('controlbot_protocol_invalid');
    }
  }

  async ack(order: ExecutionOrder): Promise<{ acknowledged: true; order_id: string; fingerprint: string }> {
    const parsed = parseExecutionOrder(order);
    const known = this.#validatedOrders.get(parsed.order_id);
    const fingerprint = orderFingerprint(parsed);
    if (!known || known.fingerprint !== fingerprint) {
      throw new ControlBotClientError('controlbot_protocol_invalid');
    }

    const request: ControlBotAckRequest = {
      version: 1,
      order_id: parsed.order_id,
      runner_id: this.#identity.runner_id,
      fingerprint,
    };

    try {
      await this.#transport.ack(request);
    } catch {
      throw new ControlBotClientError('controlbot_transport_failed');
    }

    return { acknowledged: true, order_id: parsed.order_id, fingerprint };
  }

  async publishEvents(eventsInput: readonly ExecutionEvent[]): Promise<{ published: number }> {
    if (!Array.isArray(eventsInput) || eventsInput.length === 0 || eventsInput.length > 128) {
      throw new TypeError('Batch de eventos inválido.');
    }

    const events = eventsInput.map((event) => parseExecutionEvent(event));
    const lastSequence = new Map<string, number>();
    for (const event of events) {
      if (event.runner_id !== this.#identity.runner_id || !this.#validatedOrders.has(event.order_id)) {
        throw new ControlBotClientError('controlbot_protocol_invalid');
      }
      const previous = lastSequence.get(event.order_id);
      if (previous !== undefined && event.sequence <= previous) {
        throw new ControlBotClientError('controlbot_protocol_invalid');
      }
      lastSequence.set(event.order_id, event.sequence);
    }

    const request: ControlBotEventsRequest = {
      version: 1,
      runner_id: this.#identity.runner_id,
      events,
    };

    try {
      await this.#transport.publishEvents(request);
    } catch {
      throw new ControlBotClientError('controlbot_transport_failed');
    }
    return { published: events.length };
  }

  async publishHeartbeat(heartbeatInput: RunnerHeartbeat): Promise<{ published: true; sequence: number }> {
    const heartbeat = parseRunnerHeartbeat(heartbeatInput);
    try {
      assertHeartbeatMatchesIdentity(this.#identity, heartbeat);
    } catch {
      throw new ControlBotClientError('controlbot_protocol_invalid');
    }

    const request: ControlBotHeartbeatRequest = {
      version: 1,
      runner_id: this.#identity.runner_id,
      heartbeat,
    };

    try {
      await this.#transport.publishHeartbeat(request);
    } catch {
      throw new ControlBotClientError('controlbot_transport_failed');
    }
    return { published: true, sequence: heartbeat.sequence };
  }
}
