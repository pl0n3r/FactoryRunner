import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { parseExecutionEvent, type ExecutionEvent } from './event.ts';
import type { ControlBotAckRequest, ControlBotEventsRequest } from './controlbot/transport.ts';
import { asRecord, exactKeys, ref, stableSha256, uuid } from './validation.ts';

const MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type OutboxDelivery =
  | { version: 1; kind: 'ack'; delivery_id: string; fingerprint: string; request: ControlBotAckRequest }
  | { version: 1; kind: 'events'; delivery_id: string; fingerprint: string; request: ControlBotEventsRequest }
  | {
      version: 1;
      kind: 'plan-events';
      delivery_id: string;
      fingerprint: string;
      plan_fingerprint: string;
      request: ControlBotEventsRequest;
    };
export type RecoveredOutbox = { pending: readonly OutboxDelivery[]; delivered: readonly OutboxDelivery[] };
type OutboxRecord =
  | { version: 1; op: 'enqueue'; delivery: OutboxDelivery }
  | { version: 1; op: 'delivered'; delivery_id: string; fingerprint: string };

export class DurableOutboxError extends Error {
  readonly code: 'outbox_invalid' | 'outbox_io';
  constructor(code: DurableOutboxError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableOutboxError';
    this.code = code;
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new DurableOutboxError('outbox_invalid', message, cause === undefined ? undefined : { cause });
}
function sha256(value: unknown, label: string): string {
  const parsed = ref(value, label, 64).toLowerCase();
  if (!SHA256_RE.test(parsed)) throw new TypeError(`${label} inválido.`);
  return parsed;
}
function parseAckRequest(input: unknown): ControlBotAckRequest {
  const record = asRecord(input, 'ControlBotAckRequest');
  exactKeys(record, ['version', 'order_id', 'runner_id', 'fingerprint'], 'ControlBotAckRequest');
  if (record.version !== 1) throw new TypeError('Versión ACK inválida.');
  return {
    version: 1,
    order_id: uuid(record.order_id, 'order_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    fingerprint: sha256(record.fingerprint, 'fingerprint'),
  };
}
function parseEventsRequest(input: unknown): ControlBotEventsRequest {
  const record = asRecord(input, 'ControlBotEventsRequest');
  exactKeys(record, ['version', 'runner_id', 'events'], 'ControlBotEventsRequest');
  if (record.version !== 1 || !Array.isArray(record.events) || record.events.length === 0 || record.events.length > 128) {
    throw new TypeError('Batch de eventos inválido.');
  }
  const runnerId = uuid(record.runner_id, 'runner_id');
  const events: ExecutionEvent[] = record.events.map((raw) => parseExecutionEvent(raw));
  if (events.some((event) => event.runner_id !== runnerId)) throw new TypeError('Evento pertenece a otro runner.');
  return { version: 1, runner_id: runnerId, events };
}
function buildDelivery(
  kind: 'ack' | 'events' | 'plan-events',
  input: unknown,
  planFingerprintInput?: unknown,
): OutboxDelivery {
  if (kind === 'ack') {
    const request = parseAckRequest(input);
    const fingerprint = stableSha256({ kind, request });
    return { version: 1, kind, delivery_id: `outbox:${kind}:${fingerprint}`, fingerprint, request };
  }
  const request = parseEventsRequest(input);
  if (kind === 'plan-events') {
    const planFingerprint = sha256(planFingerprintInput, 'plan_fingerprint');
    const fingerprint = stableSha256({ kind, plan_fingerprint: planFingerprint, request });
    return {
      version: 1,
      kind,
      delivery_id: `outbox:${kind}:${fingerprint}`,
      fingerprint,
      plan_fingerprint: planFingerprint,
      request,
    };
  }
  const fingerprint = stableSha256({ kind, request });
  return { version: 1, kind, delivery_id: `outbox:${kind}:${fingerprint}`, fingerprint, request };
}
function parseDelivery(input: unknown): OutboxDelivery {
  const record = asRecord(input, 'outbox delivery');
  if (record.kind === 'plan-events') {
    exactKeys(
      record,
      ['version', 'kind', 'delivery_id', 'fingerprint', 'plan_fingerprint', 'request'],
      'outbox delivery',
    );
  } else {
    exactKeys(record, ['version', 'kind', 'delivery_id', 'fingerprint', 'request'], 'outbox delivery');
  }
  if (
    record.version !== 1
    || (record.kind !== 'ack' && record.kind !== 'events' && record.kind !== 'plan-events')
  ) invalid('Delivery de outbox inválido.');
  const expected = record.kind === 'plan-events'
    ? buildDelivery(record.kind, record.request, record.plan_fingerprint)
    : buildDelivery(record.kind, record.request);
  const deliveryId = ref(record.delivery_id, 'delivery_id', 160);
  const fingerprint = sha256(record.fingerprint, 'fingerprint');
  if (deliveryId !== expected.delivery_id || fingerprint !== expected.fingerprint) {
    invalid('Delivery de outbox no coincide con su identidad estable.');
  }
  return expected;
}
function parseRecord(input: unknown, lineNumber: number): OutboxRecord {
  const record = asRecord(input, `outbox line ${lineNumber}`);
  if (record.op === 'enqueue') {
    exactKeys(record, ['version', 'op', 'delivery'], `outbox line ${lineNumber}`);
    if (record.version !== 1) invalid(`Versión de outbox no soportada en línea ${lineNumber}.`);
    return { version: 1, op: 'enqueue', delivery: parseDelivery(record.delivery) };
  }
  if (record.op === 'delivered') {
    exactKeys(record, ['version', 'op', 'delivery_id', 'fingerprint'], `outbox line ${lineNumber}`);
    if (record.version !== 1) invalid(`Versión de outbox no soportada en línea ${lineNumber}.`);
    return {
      version: 1,
      op: 'delivered',
      delivery_id: ref(record.delivery_id, 'delivery_id', 160),
      fingerprint: sha256(record.fingerprint, 'fingerprint'),
    };
  }
  return invalid(`Operación de outbox inválida en línea ${lineNumber}.`);
}
function decodeOutbox(raw: string): OutboxRecord[] {
  if (raw.length === 0) return [];
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTBOX_BYTES) invalid('Outbox excede el límite permitido.');
  if (!raw.endsWith('\n')) invalid('Outbox truncado: falta newline final.');
  const lines = raw.slice(0, -1).split('\n');
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
      return invalid(`Registro de outbox inválido en línea ${lineNumber}.`);
    }
    try {
      return parseRecord(JSON.parse(line), lineNumber);
    } catch (error) {
      if (error instanceof DurableOutboxError) throw error;
      return invalid(`Registro corrupto en línea ${lineNumber}.`, error);
    }
  });
}
function loadOutbox(path: string): OutboxRecord[] {
  if (!existsSync(path)) return [];
  try {
    return decodeOutbox(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof DurableOutboxError) throw error;
    throw new DurableOutboxError('outbox_io', 'No fue posible leer el outbox.', { cause: error });
  }
}
function recoverRecords(records: readonly OutboxRecord[]): RecoveredOutbox {
  const deliveries = new Map<string, OutboxDelivery>();
  const deliveredIds = new Set<string>();
  for (const record of records) {
    if (record.op === 'enqueue') {
      const existing = deliveries.get(record.delivery.delivery_id);
      if (existing && stableSha256(existing) !== stableSha256(record.delivery)) invalid('Outbox contiene un delivery_id conflictivo.');
      if (!existing) deliveries.set(record.delivery.delivery_id, record.delivery);
      continue;
    }
    const delivery = deliveries.get(record.delivery_id);
    if (!delivery) invalid('Outbox marca como entregado un delivery desconocido.');
    if (delivery.fingerprint !== record.fingerprint) invalid('Outbox contiene estado de entrega conflictivo.');
    deliveredIds.add(record.delivery_id);
  }
  const pending: OutboxDelivery[] = [];
  const delivered: OutboxDelivery[] = [];
  for (const delivery of deliveries.values()) {
    (deliveredIds.has(delivery.delivery_id) ? delivered : pending).push(delivery);
  }
  return { pending, delivered };
}
function persistRecord(path: string, record: OutboxRecord): void {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) invalid('Registro de outbox excede el límite permitido.');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'a', 0o600);
    appendFileSync(descriptor, serialized, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } catch (error) {
    throw new DurableOutboxError('outbox_io', 'No fue posible persistir el outbox.', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class DurableOutbox {
  readonly #path: string;
  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new TypeError('Ruta de outbox inválida.');
    this.#path = path;
  }
  recover(): RecoveredOutbox {
    return recoverRecords(loadOutbox(this.#path));
  }
  enqueueAck(input: unknown): OutboxDelivery {
    return this.#enqueue(buildDelivery('ack', input));
  }
  enqueueEvents(input: unknown): OutboxDelivery {
    return this.#enqueue(buildDelivery('events', input));
  }
  enqueuePlanEvents(input: unknown, planFingerprintInput: unknown): OutboxDelivery {
    return this.#enqueue(buildDelivery('plan-events', input, planFingerprintInput));
  }
  markDelivered(deliveryIdInput: string): OutboxDelivery {
    const deliveryId = ref(deliveryIdInput, 'delivery_id', 160);
    const recovered = this.recover();
    const delivered = recovered.delivered.find((item) => item.delivery_id === deliveryId);
    if (delivered) return delivered;
    const pending = recovered.pending.find((item) => item.delivery_id === deliveryId);
    if (!pending) invalid('No se puede entregar un delivery desconocido.');
    persistRecord(this.#path, { version: 1, op: 'delivered', delivery_id: pending.delivery_id, fingerprint: pending.fingerprint });
    return pending;
  }
  #enqueue(delivery: OutboxDelivery): OutboxDelivery {
    const recovered = this.recover();
    const all = [...recovered.pending, ...recovered.delivered];
    const existing = all.find((item) => item.delivery_id === delivery.delivery_id);
    if (existing) {
      if (stableSha256(existing) !== stableSha256(delivery)) invalid('Reuso conflictivo de delivery_id.');
      return existing;
    }

    if (delivery.kind === 'plan-events') {
      const orderIds = new Set(delivery.request.events.map((event) => event.order_id));
      for (const prior of all) {
        if (prior.kind !== 'plan-events') continue;
        const overlaps = prior.request.events.some((event) => orderIds.has(event.order_id));
        if (!overlaps) continue;
        if (
          prior.plan_fingerprint !== delivery.plan_fingerprint
          || stableSha256(prior.request) !== stableSha256(delivery.request)
        ) {
          invalid('Replay de resultado con ExecutionPlan conflictivo.');
        }
      }
    }

    persistRecord(this.#path, { version: 1, op: 'enqueue', delivery });
    return delivery;
  }
}
