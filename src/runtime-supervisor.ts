import { randomUUID } from 'node:crypto';
import { resolveBrowserRuntimeRequest } from './browser-runtime-request.ts';
import type { BrowserLoopRequest } from './browser-loop-request.ts';
import type { ControlBotClient, ControlBotPolledOrder } from './controlbot/client.ts';
import type { ExecutionAdmissionDecision } from './execution-admission.ts';
import type { ExecutionEvent } from './event.ts';
import type { ExecutionLoop } from './execution-loop.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import type { ExecutionOrder } from './order.ts';
import { planEventBatch } from './plan-event-batch.ts';
import type { DurableJournal } from './journal.ts';
import type { DurableOutbox, OutboxDelivery } from './outbox.ts';
import { parseRunnerIdentity, type RunnerHeartbeat } from './runner.ts';
import { integer, stableSha256 } from './validation.ts';

export type RuntimeAdmissionGate = (
  order: ExecutionOrder,
  now: number,
) => ExecutionAdmissionDecision;

export type RuntimeExecutionPlanGate = (
  order: ExecutionOrder,
  admission: ExecutionAdmissionDecision,
  now: number,
) => ExecutionPlan;

export type RuntimeBrowserRequestResolver = (
  order: ExecutionOrder,
  plan: ExecutionPlan,
) => unknown;

export type RuntimeSupervisorDependencies = {
  client: ControlBotClient;
  journal: DurableJournal;
  outbox: DurableOutbox;
  loop: ExecutionLoop;
  admission?: RuntimeAdmissionGate;
  plan?: RuntimeExecutionPlanGate;
  browser_request?: RuntimeBrowserRequestResolver;
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
  readonly #admission: RuntimeAdmissionGate | null;
  readonly #plan: RuntimeExecutionPlanGate | null;
  readonly #browserRequest: RuntimeBrowserRequestResolver | null;
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
    this.#admission = dependencies.admission ?? null;
    this.#plan = dependencies.plan ?? null;
    this.#browserRequest = dependencies.browser_request ?? null;
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
      const validated = this.#client.validatedOrder(order.order_id);
      const admission = this.#admission === null
        ? null
        : this.#admissionDecision(validated, now);
      if (this.#admission !== null && admission === null) continue;
      const plan = this.#revalidatedPlan(validated, admission, now);
      if (this.#plan !== null && plan === null) continue;
      this.#activeOrderIds.add(order.order_id);
      try {
        await this.#process(order, plan);
        processed += 1;
      } finally {
        this.#activeOrderIds.delete(order.order_id);
      }
    }
    if (processed === result.orders.length) this.#cursor = result.cursor;
    return { processed, cursor: this.#cursor };
  }

  #admissionDecision(
    order: ExecutionOrder,
    now: number,
  ): ExecutionAdmissionDecision | null {
    if (this.#admission === null) return null;

    let decision: ExecutionAdmissionDecision;
    try {
      decision = this.#admission(order, now);
    } catch {
      return null;
    }

    const { fingerprint, ...core } = decision;
    if (stableSha256(core) !== fingerprint) return null;
    if (
      decision.version !== 1
      || decision.decision !== 'ALLOW'
      || decision.authority !== 'unchanged'
      || decision.runner_id !== order.runner_id
      || decision.order_id !== order.order_id
      || decision.work_item_id !== order.work_item_id
    ) {
      return null;
    }
    return decision;
  }

  #executionPlan(
    order: ExecutionOrder,
    admission: ExecutionAdmissionDecision,
    now: number,
  ): ExecutionPlan | null {
    if (this.#plan === null) return null;

    let plan: ExecutionPlan;
    try {
      plan = this.#plan(order, admission, now);
    } catch {
      return null;
    }

    const { fingerprint, ...core } = plan;
    if (stableSha256(core) !== fingerprint) return null;
    if (
      plan.version !== 1
      || plan.authority !== 'unchanged'
      || plan.runner_id !== order.runner_id
      || plan.order_id !== order.order_id
      || plan.work_item_id !== order.work_item_id
      || plan.capability !== order.capability
      || plan.order_fingerprint !== admission.order_fingerprint
      || plan.admission_fingerprint !== admission.fingerprint
      || plan.manifest_fingerprint !== admission.manifest_fingerprint
      || plan.resource_fingerprint !== admission.resource_fingerprint
      || typeof plan.adapter_id !== 'string'
      || plan.adapter_id.length === 0
    ) {
      return null;
    }
    return plan;
  }

  #revalidatedPlan(
    order: ExecutionOrder,
    admission: ExecutionAdmissionDecision | null,
    now: number,
  ): ExecutionPlan | null {
    if (this.#plan === null) return null;
    if (admission === null || this.#admission === null) return null;

    const initial = this.#executionPlan(order, admission, now);
    if (initial === null) return null;

    const currentAdmission = this.#admissionDecision(order, now);
    if (
      currentAdmission === null
      || currentAdmission.fingerprint !== admission.fingerprint
    ) {
      return null;
    }

    const current = this.#executionPlan(order, currentAdmission, now);
    return current !== null && current.fingerprint === initial.fingerprint
      ? current
      : null;
  }

  async #process(
    polled: ControlBotPolledOrder,
    plan: ExecutionPlan | null,
  ): Promise<void> {
    const order = this.#client.validatedOrder(polled.order_id);
    const browserRequest = plan?.adapter_id === 'browser-execution'
      ? this.#resolvedBrowserRequest(order, plan)
      : null;
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

    if (plan === null) {
      await this.#loop.execute(order);
    } else if (browserRequest !== null) {
      await this.#loop.executeBrowserRequest(order, plan, browserRequest);
    } else {
      await this.#loop.executePlan(order, plan);
    }
    events = this.#events(order.order_id);
    if (plan === null) {
      const outbound = this.#outbox.enqueueEvents({ version: 1, runner_id: order.runner_id, events });
      await this.#deliver(outbound, () => this.#client.publishEvents(events));
      return;
    }

    const terminal = events.at(-1);
    if (terminal === undefined) {
      throw new TypeError('ExecutionPlan no produjo resultado terminal.');
    }
    const batch = planEventBatch(order, [terminal], plan);
    const terminalEvents = [...batch.events];
    const outbound = this.#outbox.enqueuePlanEvents(
      { version: 1, runner_id: batch.runner_id, events: terminalEvents },
      batch.plan_fingerprint,
    );
    await this.#deliver(outbound, () => this.#client.publishEvents(batch.events));
  }

  #resolvedBrowserRequest(
    order: ExecutionOrder,
    plan: ExecutionPlan,
  ): BrowserLoopRequest {
    if (this.#browserRequest === null) {
      throw new TypeError('Browser runtime request resolver no configurado.');
    }

    let provided: unknown;
    try {
      provided = this.#browserRequest(order, plan);
    } catch {
      throw new TypeError('Browser runtime request no disponible.');
    }
    return resolveBrowserRuntimeRequest(order, plan, provided);
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
