import { randomUUID } from 'node:crypto';
import type { ProgrammaticAdapterResult } from './adapters/programmatic.ts';
import { AdapterRegistry } from './adapters/programmatic.ts';
import type { ExecutionEvent, ExecutionState } from './event.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import type { DurableJournal } from './journal.ts';
import type { ExecutionOrder } from './order.ts';
import { assertIdempotentOrder, assertOrderExecutable, orderFingerprint, parseExecutionOrder } from './order.ts';
import type { RunnerIdentity } from './runner.ts';
import { asRecord, exactKeys, integer, ref, slug, stableSha256, uuid } from './validation.ts';

const TERMINAL_STATES = new Set<ExecutionState>(['failed', 'completed', 'cancelled']);
const PLAN_KEYS = [
  'version', 'authority', 'runner_id', 'order_id', 'work_item_id', 'capability',
  'order_fingerprint', 'admission_fingerprint', 'adapter_id',
  'manifest_fingerprint', 'resource_fingerprint', 'fingerprint',
] as const;
const PLAN_HASH_KEYS = [
  'order_fingerprint', 'admission_fingerprint', 'manifest_fingerprint',
  'resource_fingerprint', 'fingerprint',
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

function validatedExecutionPlan(input: unknown, order: ExecutionOrder): ExecutionPlan {
  const plan = asRecord(input, 'ExecutionPlan');
  exactKeys(plan, PLAN_KEYS, 'ExecutionPlan');
  if (plan.version !== 1 || plan.authority !== 'unchanged') {
    throw new TypeError('ExecutionPlan no conserva autoridad.');
  }

  const normalized = {
    runner_id: uuid(plan.runner_id, 'plan.runner_id'),
    order_id: uuid(plan.order_id, 'plan.order_id'),
    work_item_id: ref(plan.work_item_id, 'plan.work_item_id', 160),
    capability: slug(plan.capability, 'plan.capability'),
    adapter_id: slug(plan.adapter_id, 'plan.adapter_id'),
  };
  const hashes = Object.fromEntries(PLAN_HASH_KEYS.map((field) => {
    const value = plan[field];
    if (typeof value !== 'string' || !SHA256_RE.test(value)) {
      throw new TypeError(`plan.${field} inválido.`);
    }
    return [field, value];
  })) as Record<(typeof PLAN_HASH_KEYS)[number], string>;

  if (![
    normalized.runner_id === order.runner_id,
    normalized.order_id === order.order_id,
    normalized.work_item_id === order.work_item_id,
    normalized.capability === order.capability,
    hashes.order_fingerprint === orderFingerprint(order),
  ].every(Boolean)) {
    throw new TypeError('ExecutionPlan no corresponde a la orden actual.');
  }

  const { fingerprint: _ignored, ...unsigned } = plan;
  if (stableSha256(unsigned) !== hashes.fingerprint) {
    throw new TypeError('ExecutionPlan fingerprint incoherente.');
  }

  return {
    version: 1,
    authority: 'unchanged',
    ...normalized,
    order_fingerprint: hashes.order_fingerprint,
    admission_fingerprint: hashes.admission_fingerprint,
    manifest_fingerprint: hashes.manifest_fingerprint,
    resource_fingerprint: hashes.resource_fingerprint,
    fingerprint: hashes.fingerprint,
  };
}

type AdapterOutcome =
  | { kind: 'completed'; result: ProgrammaticAdapterResult }
  | { kind: 'failed' | 'timeout' | 'cancelled' };

export type ExecutionLoopResult = {
  order: ExecutionOrder;
  event: ExecutionEvent;
  adapter_result: ProgrammaticAdapterResult | null;
  reused: boolean;
};

export type ExecutionLoopOptions = {
  timeout_ms?: number;
  signal?: AbortSignal;
};

export type ExecutionLoopDependencies = {
  journal: DurableJournal;
  registry: AdapterRegistry;
  identity: RunnerIdentity;
  now?: () => number;
  event_id?: () => string;
};

export class ExecutionLoop {
  readonly #journal: DurableJournal;
  readonly #registry: AdapterRegistry;
  readonly #identity: RunnerIdentity;
  readonly #now: () => number;
  readonly #eventId: () => string;

  constructor(dependencies: ExecutionLoopDependencies) {
    this.#journal = dependencies.journal;
    this.#registry = dependencies.registry;
    this.#identity = dependencies.identity;
    this.#now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#eventId = dependencies.event_id ?? randomUUID;
  }

  async execute(input: unknown, options: ExecutionLoopOptions = {}): Promise<ExecutionLoopResult> {
    const incoming = parseExecutionOrder(input);
    return this.#executeParsed(incoming, options, null);
  }

  async executePlan(
    input: unknown,
    planInput: unknown,
    options: ExecutionLoopOptions = {},
  ): Promise<ExecutionLoopResult> {
    const incoming = parseExecutionOrder(input);
    const plan = validatedExecutionPlan(planInput, incoming);
    return this.#executeParsed(incoming, options, plan.adapter_id);
  }

  async #executeParsed(
    incoming: ExecutionOrder,
    options: ExecutionLoopOptions,
    adapterId: string | null,
  ): Promise<ExecutionLoopResult> {
    const recoveredBefore = this.#journal.recover();
    const existing = recoveredBefore.orders.find((order) => order.order_id === incoming.order_id);

    let order: ExecutionOrder;
    if (existing) {
      assertIdempotentOrder(existing, incoming);
      order = existing;
    } else {
      assertOrderExecutable(incoming, this.#identity, this.#timestamp());
      order = this.#journal.appendOrder(incoming);
    }

    let history = this.#events(order.order_id);
    const last = history.at(-1);
    if (last && TERMINAL_STATES.has(last.state)) {
      return { order, event: last, adapter_result: null, reused: true };
    }

    if (last && last.state !== 'accepted') {
      const interrupted = this.#append(order, last.sequence + 1, 'failed', {
        code: 'restart-interrupted',
        summary: 'Recovered non-terminal execution; retry refused to avoid duplicate effect',
        ref: null,
      });
      return { order, event: interrupted, adapter_result: null, reused: true };
    }

    if (
      order.runner_id !== this.#identity.runner_id
      || !this.#identity.capabilities.includes(order.capability)
    ) {
      throw new TypeError('Orden no pertenece a este runner o capability.');
    }

    const now = this.#timestamp();
    try {
      assertOrderExecutable(order, this.#identity, now);
    } catch {
      if (last?.state === 'accepted') {
        const expired = this.#append(order, last.sequence + 1, 'failed', {
          code: 'order-not-executable',
          summary: 'Recovered order is no longer executable',
          ref: null,
        });
        return { order, event: expired, adapter_result: null, reused: true };
      }
      throw new TypeError('Orden no ejecutable.');
    }

    if (!last) {
      this.#append(order, 1, 'accepted', {
        code: 'accepted',
        summary: 'Validated order accepted by execution loop',
        ref: null,
      });
      history = this.#events(order.order_id);
    }

    const accepted = history.at(-1);
    if (!accepted || accepted.state !== 'accepted') {
      throw new TypeError('Estado de ejecución inconsistente.');
    }

    const timeoutMs = integer(options.timeout_ms ?? 30_000, 'timeout_ms', 1, 30_000);
    if (options.signal?.aborted) {
      const cancelled = this.#append(order, accepted.sequence + 1, 'cancelled', {
        code: 'cancelled',
        summary: 'Execution cancelled before adapter dispatch',
        ref: null,
      });
      return { order, event: cancelled, adapter_result: null, reused: false };
    }

    const started = this.#append(order, accepted.sequence + 1, 'started', {
      code: 'started',
      summary: 'Adapter dispatch started',
      ref: null,
    });
    const outcome = await this.#runAdapter(order.capability, timeoutMs, options.signal, adapterId);

    if (outcome.kind === 'completed') {
      const completed = this.#append(order, started.sequence + 1, 'completed', outcome.result.evidence);
      return { order, event: completed, adapter_result: outcome.result, reused: false };
    }

    const state: ExecutionState = outcome.kind === 'cancelled' ? 'cancelled' : 'failed';
    const evidence = outcome.kind === 'timeout'
      ? { code: 'timeout', summary: 'Adapter execution timed out', ref: null }
      : outcome.kind === 'cancelled'
        ? { code: 'cancelled', summary: 'Adapter execution cancelled', ref: null }
        : { code: 'adapter-failed', summary: 'Adapter execution failed', ref: null };
    const terminal = this.#append(order, started.sequence + 1, state, evidence);
    return { order, event: terminal, adapter_result: null, reused: false };
  }

  #events(orderId: string): ExecutionEvent[] {
    return this.#journal.recover().events.filter((event) => event.order_id === orderId);
  }

  #timestamp(): number {
    return integer(this.#now(), 'now');
  }

  #append(
    order: ExecutionOrder,
    sequence: number,
    state: ExecutionState,
    evidence: ExecutionEvent['evidence'],
  ): ExecutionEvent {
    return this.#journal.appendEvent({
      version: 1,
      event_id: this.#eventId(),
      order_id: order.order_id,
      runner_id: order.runner_id,
      sequence,
      state,
      occurred_at: this.#timestamp(),
      evidence,
    });
  }

  #runAdapter(
    capability: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    adapterId: string | null,
  ): Promise<AdapterOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: AdapterOutcome) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: 'cancelled' });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        finish({ kind: 'cancelled' });
        return;
      }

      timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      const execution = adapterId === null
        ? this.#registry.execute(capability)
        : this.#registry.executeAdapter(adapterId, capability);
      execution.then(
        (result) => finish({ kind: 'completed', result }),
        () => finish({ kind: 'failed' }),
      );
    });
  }
}
