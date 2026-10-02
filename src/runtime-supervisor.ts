import { randomUUID } from 'node:crypto';
import type { ControlBotClient, ControlBotPolledOrder } from './controlbot/client.ts';
import type { ExecutionEvent } from './event.ts';
import type { ExecutionLoop } from './execution-loop.ts';
import type { DurableJournal } from './journal.ts';
import type { DurableOutbox, OutboxDelivery } from './outbox.ts';
import { parseRunnerIdentity, type RunnerHeartbeat } from './runner.ts';
import { integer } from './validation.ts';

export type RuntimeSupervisorDependencies = {
  client: ControlBotClient;
  journal: DurableJournal;
  outbox: DurableOutbox;
  loop: ExecutionLoop;
  now?: () => number;
  event_id?: () => string;
};

export type RuntimeTickResult = {
  processed: number;
  cursor: string | null;
};

export class RuntimeSupervisor {
  readonly #client: ControlBotClient;
  readonly #journal: DurableJournal;
  readonly #outbox: DurableOutbox;
  readonly #loop: ExecutionLoop;
  readonly #now: () => number;
  readonly #eventId: () => string;
  readonly #activeOrderIds = new Set<string>();
  #cursor: string | null = null;
  #draining = false;

  constructor(dependencies: RuntimeSupervisorDependencies) {
    this.#client = dependencies.client;
    this.#journal = dependencies.journal;
    this.#outbox = dependencies.outbox;
    this.#loop = dependencies.loop;
    this.#now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#eventId = dependencies.event_id ?? randomUUID;
  }

  beginDrain(): void {
    this.#draining = true;
  }

  isDrained(): boolean {
    return this.#draining && this.#activeOrderIds.size === 0;
  }

  heartbeat(identityInput: unknown, sequenceInput: unknown): RunnerHeartbeat {
    const identity = parseRunnerIdentity(identityInput);
    const activeSessions = [...this.#activeOrderIds].sort((a, b) => a.localeCompare(b, 'en'));
    if (activeSessions.length > identity.max_parallel) {
      throw new TypeError('Estado runtime excede max_parallel.');
    }
    return {
      version: 1,
      runner_id: identity.runner_id,
      sequence: integer(sequenceInput, 'sequence'),
      observed_at: integer(this.#now(), 'now'),
      status: this.#draining ? 'draining' : activeSessions.length > 0 ? 'busy' : 'ready',
      capacity: { max: identity.max_parallel, active: activeSessions.length },
      active_sessions: activeSessions,
    };
  }

  async publishHeartbeat(identityInput: unknown, sequenceInput: unknown): Promise<RunnerHeartbeat> {
    const heartbeat = this.heartbeat(identityInput, sequenceInput);
    await this.#client.publishHeartbeat(heartbeat);
    return heartbeat;
  }

  async tick(limit = 16): Promise<RuntimeTickResult> {
    if (this.#draining) return { processed: 0, cursor: this.#cursor };
    const now = integer(this.#now(), 'now');
    const result = await this.#client.poll(this.#cursor, integer(limit, 'limit', 1, 64), now);
    let processed = 0;
    for (const order of result.orders) {
      if (this.#draining) break;
      this.#activeOrderIds.add(order.order_id);
      try {
        await this.#process(order);
        processed += 1;
      } finally {
        this.#activeOrderIds.delete(order.order_id);
      }
    }
    if (processed === result.orders.length) this.#cursor = result.cursor;
    return { processed, cursor: this.#cursor };
  }

  async #process(polled: ControlBotPolledOrder): Promise<void> {
    const order = this.#client.validatedOrder(polled.order_id);
    const recovered = this.#journal.recover();
    if (!recovered.orders.some((item) => item.order_id === order.order_id)) {
      this.#journal.appendOrder(order);
    }

    let events = this.#events(order.order_id);
    if (events.length === 0) {
      this.#journal.appendEvent({
        version: 1,
        event_id: this.#eventId(),
        order_id: order.order_id,
        runner_id: order.runner_id,
        sequence: 1,
        state: 'accepted',
        occurred_at: integer(this.#now(), 'now'),
        evidence: { code: 'accepted', summary: 'Order durably accepted by runtime supervisor', ref: null },
      });
    }

    const ack = this.#outbox.enqueueAck({
      version: 1,
      order_id: order.order_id,
      runner_id: order.runner_id,
      fingerprint: polled.fingerprint,
    });
    await this.#deliver(ack, () => this.#client.ack(order.order_id));

    await this.#loop.execute(order);
    events = this.#events(order.order_id);
    const outbound = this.#outbox.enqueueEvents({ version: 1, runner_id: order.runner_id, events });
    await this.#deliver(outbound, () => this.#client.publishEvents(events));
  }

  #events(orderId: string): ExecutionEvent[] {
    return this.#journal.recover().events.filter((event) => event.order_id === orderId);
  }

  async #deliver(delivery: OutboxDelivery, send: () => Promise<unknown>): Promise<void> {
    if (this.#outbox.recover().delivered.some((item) => item.delivery_id === delivery.delivery_id)) return;
    await send();
    this.#outbox.markDelivered(delivery.delivery_id);
  }
}
