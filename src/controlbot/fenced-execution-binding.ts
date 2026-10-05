import {
  controlBotRunnerHttpRequest,
  type ControlBotRunnerHttpEnvelope,
} from './http-protocol-v1.ts';
import {
  orderFingerprint,
  parseExecutionOrder,
  type ExecutionOrder,
} from '../order.ts';
import {
  asRecord,
  capability,
  exactKeys,
  integer,
  ref,
  stableSha256,
  uuid,
  type JsonRecord,
} from '../validation.ts';

export type ControlBotExecutionOrderV1 = Readonly<{
  version: 1;
  order_id: string;
  attempt_id: string;
  generation: number;
  work_item_id: string;
  runner_id: string;
  capability: string;
  attempt: number;
  scope: string;
  issued_at: number;
  expires_at: number;
  instruction_ref: string;
}>;

export type FencedExecutionSessionV1 = Readonly<{
  version: 1;
  session_id: string;
  runner_id: string;
  generation: number;
  scope: string;
}>;

export type FencedExecutionBinding = Readonly<{
  version: 1;
  session_id: string;
  generation: number;
  attempt_id: string;
  scope: string;
  runner_id: string;
  order_id: string;
  work_item_id: string;
  internal_order_fingerprint: string;
  binding_fingerprint: string;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

export type FencedExecutionOutcome = Readonly<{
  version: 1;
  kind: 'ack' | 'event';
  session_id: string;
  generation: number;
  attempt_id: string;
  scope: string;
  runner_id: string;
  order_id: string;
  binding_fingerprint: string;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

const MAX_GENERATION = 1_000_000_000;
const HASH_RE = /^[0-9a-f]{64}$/;

const ORDER_FIELDS = Object.freeze([
  'version',
  'order_id',
  'attempt_id',
  'generation',
  'work_item_id',
  'runner_id',
  'capability',
  'attempt',
  'scope',
  'issued_at',
  'expires_at',
  'instruction_ref',
]);

const SESSION_FIELDS = Object.freeze([
  'version',
  'session_id',
  'runner_id',
  'generation',
  'scope',
]);

const BINDING_FIELDS = Object.freeze([
  'version',
  'session_id',
  'generation',
  'attempt_id',
  'scope',
  'runner_id',
  'order_id',
  'work_item_id',
  'internal_order_fingerprint',
  'binding_fingerprint',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
]);

const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function parseControlBotExecutionOrder(input: unknown): ControlBotExecutionOrderV1 {
  const record = asRecord(input, 'ControlBotExecutionOrderV1');
  exactKeys(record, ORDER_FIELDS, 'ControlBotExecutionOrderV1');
  if (record.version !== 1) throw new TypeError('ControlBotExecutionOrderV1 version inválida.');

  const issuedAt = integer(record.issued_at, 'issued_at');
  const expiresAt = integer(record.expires_at, 'expires_at', issuedAt + 1);
  if (expiresAt - issuedAt > 86_400) throw new TypeError('TTL de orden excesivo.');

  const instructionRef = ref(record.instruction_ref, 'instruction_ref', 256);
  if (!instructionRef.startsWith('controlbot:')) {
    throw new TypeError('instruction_ref debe pertenecer a ControlBot.');
  }

  return Object.freeze({
    version: 1,
    order_id: uuid(record.order_id, 'order_id'),
    attempt_id: uuid(record.attempt_id, 'attempt_id'),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    work_item_id: ref(record.work_item_id, 'work_item_id', 160),
    runner_id: uuid(record.runner_id, 'runner_id'),
    capability: capability(record.capability, 'capability'),
    attempt: integer(record.attempt, 'attempt', 1, 10),
    scope: ref(record.scope, 'scope', 160),
    issued_at: issuedAt,
    expires_at: expiresAt,
    instruction_ref: instructionRef,
  });
}

function parseSession(input: unknown): FencedExecutionSessionV1 {
  const record = asRecord(input, 'FencedExecutionSessionV1');
  exactKeys(record, SESSION_FIELDS, 'FencedExecutionSessionV1');
  if (record.version !== 1) throw new TypeError('FencedExecutionSessionV1 version inválida.');

  return Object.freeze({
    version: 1,
    session_id: ref(record.session_id, 'session_id', 160),
    runner_id: uuid(record.runner_id, 'runner_id'),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    scope: ref(record.scope, 'scope', 160),
  });
}

function internalProjection(order: ControlBotExecutionOrderV1): ExecutionOrder {
  return {
    version: 1,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    runner_id: order.runner_id,
    capability: order.capability,
    attempt: order.attempt,
    issued_at: order.issued_at,
    expires_at: order.expires_at,
    instruction_ref: order.instruction_ref,
  };
}

function bindingCore(
  session: FencedExecutionSessionV1,
  order: ControlBotExecutionOrderV1,
  internalFingerprint: string,
): Omit<FencedExecutionBinding, 'binding_fingerprint' | keyof typeof SAFETY> {
  return {
    version: 1,
    session_id: session.session_id,
    generation: session.generation,
    attempt_id: order.attempt_id,
    scope: session.scope,
    runner_id: order.runner_id,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    internal_order_fingerprint: internalFingerprint,
  };
}

function parseBinding(input: unknown): FencedExecutionBinding {
  const record = asRecord(input, 'FencedExecutionBinding');
  exactKeys(record, BINDING_FIELDS, 'FencedExecutionBinding');

  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('FencedExecutionBinding safety inválida.');
  }

  const parsedCore = {
    version: 1 as const,
    session_id: ref(record.session_id, 'session_id', 160),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    attempt_id: uuid(record.attempt_id, 'attempt_id'),
    scope: ref(record.scope, 'scope', 160),
    runner_id: uuid(record.runner_id, 'runner_id'),
    order_id: uuid(record.order_id, 'order_id'),
    work_item_id: ref(record.work_item_id, 'work_item_id', 160),
    internal_order_fingerprint: String(record.internal_order_fingerprint),
  };
  if (!HASH_RE.test(parsedCore.internal_order_fingerprint)) {
    throw new TypeError('internal_order_fingerprint inválido.');
  }

  const bindingFingerprint = String(record.binding_fingerprint);
  if (!HASH_RE.test(bindingFingerprint)) throw new TypeError('binding_fingerprint inválido.');

  const expectedFingerprint = stableSha256(parsedCore);
  if (bindingFingerprint !== expectedFingerprint) {
    throw new TypeError('FencedExecutionBinding fingerprint inválido.');
  }

  return Object.freeze({
    ...parsedCore,
    binding_fingerprint: bindingFingerprint,
    ...SAFETY,
  });
}

function pollContext(input: unknown): Readonly<{
  session_id: string;
  generation: number;
  runner_id: string;
}> {
  const result = controlBotRunnerHttpRequest(input);
  if (result.path !== '/v1/runner/poll') {
    throw new TypeError('Se requiere envelope poll validado.');
  }
  const payload = asRecord(result.payload, 'RunnerPoll');
  return Object.freeze({
    session_id: ref(payload.session_id, 'session_id', 160),
    generation: integer(payload.generation, 'generation', 1, MAX_GENERATION),
    runner_id: uuid(payload.runner_id, 'runner_id'),
  });
}

function assertInternalOrderMatches(
  controlBotOrder: ControlBotExecutionOrderV1,
  internalOrderInput: unknown,
): string {
  const internalOrder = parseExecutionOrder(internalOrderInput);
  const expected = internalProjection(controlBotOrder);
  const actualFingerprint = orderFingerprint(internalOrder);
  const expectedFingerprint = orderFingerprint(expected);
  if (actualFingerprint !== expectedFingerprint) {
    throw new TypeError('ExecutionOrder interno no coincide con la orden ControlBot.');
  }
  return actualFingerprint;
}

export function bindFencedExecution(
  sessionInput: unknown,
  pollEnvelopeInput: ControlBotRunnerHttpEnvelope | unknown,
  controlBotOrderInput: unknown,
  internalOrderInput: unknown,
): FencedExecutionBinding {
  const session = parseSession(sessionInput);
  const poll = pollContext(pollEnvelopeInput);
  const controlBotOrder = parseControlBotExecutionOrder(controlBotOrderInput);

  if (
    poll.session_id !== session.session_id
    || poll.runner_id !== session.runner_id
    || poll.generation !== session.generation
  ) {
    throw new TypeError('Session/poll fence mismatch.');
  }

  if (
    controlBotOrder.runner_id !== session.runner_id
    || controlBotOrder.generation !== session.generation
    || controlBotOrder.scope !== session.scope
  ) {
    throw new TypeError('Order/session fence mismatch.');
  }

  const internalFingerprint = assertInternalOrderMatches(controlBotOrder, internalOrderInput);
  const core = bindingCore(session, controlBotOrder, internalFingerprint);

  return Object.freeze({
    ...core,
    binding_fingerprint: stableSha256(core),
    ...SAFETY,
  });
}

function outcome(
  bindingInput: unknown,
  envelopeInput: ControlBotRunnerHttpEnvelope | unknown,
  kind: 'ack' | 'event',
): FencedExecutionOutcome {
  const binding = parseBinding(bindingInput);
  const result = controlBotRunnerHttpRequest(envelopeInput);
  const expectedPath = kind === 'ack' ? '/v1/runner/ack' : '/v1/runner/event';
  if (result.path !== expectedPath) throw new TypeError('Envelope de outcome inválido.');

  const payload = asRecord(result.payload, kind === 'ack' ? 'RunnerAck' : 'ExecutionEvent');
  const identity = {
    order_id: uuid(payload.order_id, 'order_id'),
    attempt_id: uuid(payload.attempt_id, 'attempt_id'),
    runner_id: uuid(payload.runner_id, 'runner_id'),
    generation: integer(payload.generation, 'generation', 1, MAX_GENERATION),
  };

  if (
    identity.order_id !== binding.order_id
    || identity.attempt_id !== binding.attempt_id
    || identity.runner_id !== binding.runner_id
    || identity.generation !== binding.generation
  ) {
    throw new TypeError('Outcome stale/foreign para el binding de ejecución.');
  }

  return Object.freeze({
    version: 1,
    kind,
    session_id: binding.session_id,
    generation: binding.generation,
    attempt_id: binding.attempt_id,
    scope: binding.scope,
    runner_id: binding.runner_id,
    order_id: binding.order_id,
    binding_fingerprint: binding.binding_fingerprint,
    ...SAFETY,
  });
}

export function assertFencedAck(
  bindingInput: unknown,
  ackEnvelopeInput: ControlBotRunnerHttpEnvelope | unknown,
): FencedExecutionOutcome {
  return outcome(bindingInput, ackEnvelopeInput, 'ack');
}

export function assertFencedEvent(
  bindingInput: unknown,
  eventEnvelopeInput: ControlBotRunnerHttpEnvelope | unknown,
): FencedExecutionOutcome {
  return outcome(bindingInput, eventEnvelopeInput, 'event');
}
