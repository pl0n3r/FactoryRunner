import { randomUUID } from 'node:crypto';
import type { BrowserExecutionResult } from './adapters/browser.ts';
import { BrowserExecutionAdapter } from './adapters/browser.ts';
import type { ProgrammaticAdapterResult } from './adapters/programmatic.ts';
import { AdapterRegistry } from './adapters/programmatic.ts';
import { browserLoopRequest, type BrowserLoopRequest } from './browser-loop-request.ts';
import type { BrowserPlanBatch } from './browser-plan-batch.ts';
import type { BrowserPlanStep } from './browser-plan.ts';
import type { ExecutionEvent, ExecutionState } from './event.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import type { DurableJournal } from './journal.ts';
import type { ExecutionOrder } from './order.ts';
import { assertIdempotentOrder, assertOrderExecutable, orderFingerprint, parseExecutionOrder } from './order.ts';
import type { RunnerIdentity } from './runner.ts';
import { asRecord, capability, exactKeys, integer, ref, slug, stableSha256, uuid } from './validation.ts';

const TERMINAL_STATES = new Set<ExecutionState>(['failed', 'completed', 'cancelled']);
const PLAN_KEYS = [
  'version', 'authority', 'runner_id', 'order_id', 'work_item_id', 'capability',
  'order_fingerprint', 'admission_fingerprint', 'adapter_id',
  'manifest_fingerprint', 'resource_fingerprint', 'fingerprint',
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

function validatedExecutionPlan(input: unknown, order: ExecutionOrder): ExecutionPlan {
  const plan = asRecord(input, 'ExecutionPlan');
  exactKeys(plan, PLAN_KEYS, 'ExecutionPlan');
  if (plan.version !== 1 || plan.authority !== 'unchanged') {
    throw new TypeError('ExecutionPlan no conserva autoridad.');
  }

  const fingerprint = ref(plan.fingerprint, 'plan.fingerprint', 64);
  const { fingerprint: _ignored, ...unsigned } = plan;
  if (!SHA256_RE.test(fingerprint) || stableSha256(unsigned) !== fingerprint) {
    throw new TypeError('ExecutionPlan fingerprint incoherente.');
  }

  const adapterId = slug(plan.adapter_id, 'plan.adapter_id');
  if (
    uuid(plan.runner_id, 'plan.runner_id') !== order.runner_id
    || uuid(plan.order_id, 'plan.order_id') !== order.order_id
    || ref(plan.work_item_id, 'plan.work_item_id', 160) !== order.work_item_id
    || capability(plan.capability, 'plan.capability') !== order.capability
    || plan.order_fingerprint !== orderFingerprint(order)
  ) {
    throw new TypeError('ExecutionPlan no corresponde a la orden actual.');
  }

  return { ...(plan as unknown as ExecutionPlan), adapter_id: adapterId, fingerprint };
}

function validatedBrowserLoopRequest(
  orderInput: unknown,
  planInput: unknown,
  input: unknown,
): BrowserLoopRequest {
  const request = asRecord(input, 'BrowserLoopRequest');
  exactKeys(request, [
    'version',
    'authority',
    'order_id',
    'runner_id',
    'work_item_id',
    'plan_fingerprint',
    'adapter_id',
    'capability',
    'browser_kind',
    'browser_fingerprint',
    'browser',
    'fingerprint',
  ], 'BrowserLoopRequest');

  const canonical = browserLoopRequest(orderInput, planInput, {
    version: request.version,
    browser_kind: request.browser_kind,
    browser: request.browser,
  });

  if (
    request.authority !== canonical.authority
    || request.order_id !== canonical.order_id
    || request.runner_id !== canonical.runner_id
    || request.work_item_id !== canonical.work_item_id
    || request.plan_fingerprint !== canonical.plan_fingerprint
    || request.adapter_id !== canonical.adapter_id
    || request.capability !== canonical.capability
    || request.browser_kind !== canonical.browser_kind
    || request.browser_fingerprint !== canonical.browser_fingerprint
    || request.fingerprint !== canonical.fingerprint
    || stableSha256(request.browser) !== stableSha256(canonical.browser)
  ) {
    throw new TypeError('BrowserLoopRequest no corresponde al binding canónico.');
  }

  return canonical;
}

type AdapterOutcome<T> =
  | { kind: 'completed'; result: T }
  | { kind: 'failed' | 'timeout' | 'cancelled' };

export type ExecutionLoopResult<TAdapterResult = ProgrammaticAdapterResult> = {
  order: ExecutionOrder;
  event: ExecutionEvent;
  adapter_result: TAdapterResult | null;
  reused: boolean;
};

export type ExecutionLoopOptions = {
  timeout_ms?: number;
  signal?: AbortSignal;
};

export type ExecutionLoopDependencies = {
  journal: DurableJournal;
  registry: AdapterRegistry;
  browser_adapter?: BrowserExecutionAdapter;
  identity: RunnerIdentity;
  now?: () => number;
  event_id?: () => string;
};

export class ExecutionLoop {
  readonly #journal: DurableJournal;
  readonly #registry: AdapterRegistry;
  readonly #browserAdapter: BrowserExecutionAdapter | null;
  readonly #identity: RunnerIdentity;
  readonly #now: () => number;
  readonly #eventId: () => string;

  constructor(dependencies: ExecutionLoopDependencies) {
    this.#journal = dependencies.journal;
    this.#registry = dependencies.registry;
    this.#browserAdapter = dependencies.browser_adapter ?? null;
    this.#identity = dependencies.identity;
    this.#now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#eventId = dependencies.event_id ?? randomUUID;
  }

  async execute(input: unknown, options: ExecutionLoopOptions = {}): Promise<ExecutionLoopResult> {
    const incoming = parseExecutionOrder(input);
    return this.#executeParsed(
      incoming,
      options,
      (timeoutMs, signal) => this.#runAdapter(incoming.capability, timeoutMs, signal, null),
      (result) => result.evidence,
    );
  }

  async executePlan(
    input: unknown,
    planInput: unknown,
    options: ExecutionLoopOptions = {},
  ): Promise<ExecutionLoopResult> {
    const incoming = parseExecutionOrder(input);
    const plan = validatedExecutionPlan(planInput, incoming);
    return this.#executeParsed(
      incoming,
      options,
      (timeoutMs, signal) => this.#runAdapter(incoming.capability, timeoutMs, signal, plan.adapter_id),
      (result) => result.evidence,
    );
  }

  async executeBrowserRequest(
    input: unknown,
    planInput: unknown,
    requestInput: unknown,
    options: ExecutionLoopOptions = {},
  ): Promise<ExecutionLoopResult<readonly BrowserExecutionResult[]>> {
    const incoming = parseExecutionOrder(input);
    const plan = validatedExecutionPlan(planInput, incoming);
    const request = validatedBrowserLoopRequest(incoming, plan, requestInput);
    const adapter = this.#browserAdapter;

    if (adapter === null) {
      throw new TypeError('BrowserExecutionAdapter no configurado.');
    }
    if (
      adapter.id !== request.adapter_id
      || plan.adapter_id !== request.adapter_id
      || plan.fingerprint !== request.plan_fingerprint
      || plan.capability !== request.capability
    ) {
      throw new TypeError('BrowserLoopRequest no corresponde al adapter o ExecutionPlan.');
    }

    return this.#executeParsed(
      incoming,
      options,
      (timeoutMs, signal) => this.#runBrowserRequest(incoming, plan, request, timeoutMs, signal),
      (results) => ({
        code: 'browser-completed',
        summary: `Browser plan-bound execution completed with ${results.length} step(s)`,
        ref: null,
      }),
    );
  }

  async #executeParsed<TAdapterResult>(
    incoming: ExecutionOrder,
    options: ExecutionLoopOptions,
    dispatch: (
      timeoutMs: number,
      signal: AbortSignal | undefined,
    ) => Promise<AdapterOutcome<TAdapterResult>>,
    completedEvidence: (result: TAdapterResult) => ExecutionEvent['evidence'],
  ): Promise<ExecutionLoopResult<TAdapterResult>> {
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
    const outcome = await dispatch(timeoutMs, options.signal);

    if (outcome.kind === 'completed') {
      const completed = this.#append(order, started.sequence + 1, 'completed', completedEvidence(outcome.result));
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

  #runBrowserRequest(
    order: ExecutionOrder,
    plan: ExecutionPlan,
    request: BrowserLoopRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<AdapterOutcome<readonly BrowserExecutionResult[]>> {
    const adapter = this.#browserAdapter;
    if (adapter === null) {
      throw new TypeError('BrowserExecutionAdapter no configurado.');
    }

    return new Promise((resolve) => {
      let settled = false;
      let halted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: AdapterOutcome<readonly BrowserExecutionResult[]>) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => {
        halted = true;
        finish({ kind: 'cancelled' });
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      timer = setTimeout(() => {
        halted = true;
        finish({ kind: 'timeout' });
      }, timeoutMs);

      const execution = (async (): Promise<readonly BrowserExecutionResult[]> => {
        const steps: readonly BrowserPlanStep[] = request.browser_kind === 'step'
          ? [request.browser as BrowserPlanStep]
          : (request.browser as BrowserPlanBatch).steps.map((item) => item.step);
        const results: BrowserExecutionResult[] = [];
        for (const step of steps) {
          if (halted) throw new TypeError('Browser execution halted.');
          results.push(await adapter.executePlanStep(order, plan, step));
        }
        return Object.freeze(results);
      })();

      execution.then(
        (result) => finish({ kind: 'completed', result }),
        () => finish({ kind: 'failed' }),
      );
    });
  }

  #runAdapter(
    capability: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    adapterId: string | null,
  ): Promise<AdapterOutcome<ProgrammaticAdapterResult>> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: AdapterOutcome<ProgrammaticAdapterResult>) => {
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
