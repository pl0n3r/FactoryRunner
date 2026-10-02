import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import type { ExecutionEvent, ExecutionState } from './event.ts';
import { assertEventTransition, assertInitialEventMatchesOrder, parseExecutionEvent } from './event.ts';
import type { ExecutionOrder } from './order.ts';
import { assertIdempotentOrder, parseExecutionOrder } from './order.ts';
import { asRecord, exactKeys, stableSha256, uuid } from './validation.ts';

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;

type JournalRecord =
  | { version: 1; kind: 'order'; payload: ExecutionOrder }
  | { version: 1; kind: 'event'; payload: ExecutionEvent };

export type RecoveredJournal = {
  orders: readonly ExecutionOrder[];
  events: readonly ExecutionEvent[];
};

export type RecoveredExecution = {
  order: ExecutionOrder;
  events: readonly ExecutionEvent[];
  last_event: ExecutionEvent | null;
  recovery: 'accepted' | 'interrupted' | 'terminal';
};

const TERMINAL_EXECUTION_STATES = new Set<ExecutionState>([
  'failed',
  'completed',
  'cancelled',
]);

export class DurableJournalError extends Error {
  readonly code: 'journal_invalid' | 'journal_io';

  constructor(code: DurableJournalError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableJournalError';
    this.code = code;
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new DurableJournalError('journal_invalid', message, cause === undefined ? undefined : { cause });
}
function parseRecord(input: unknown, lineNumber: number): JournalRecord {
  const record = asRecord(input, `journal line ${lineNumber}`);
  exactKeys(record, ['version', 'kind', 'payload'], `journal line ${lineNumber}`);
  if (record.version !== 1) invalid(`Versión de journal no soportada en línea ${lineNumber}.`);

  if (record.kind === 'order') {
    return { version: 1, kind: 'order', payload: parseExecutionOrder(record.payload) };
  }
  if (record.kind === 'event') {
    return { version: 1, kind: 'event', payload: parseExecutionEvent(record.payload) };
  }
  return invalid(`Tipo de journal inválido en línea ${lineNumber}.`);
}

function readRecords(path: string): JournalRecord[] {
  if (!existsSync(path)) return [];

  let raw: Buffer;
  try {
    if (statSync(path).size > MAX_JOURNAL_BYTES) invalid('Journal excede el límite permitido.');
    raw = readFileSync(path);
  } catch (error) {
    if (error instanceof DurableJournalError) throw error;
    throw new DurableJournalError('journal_io', 'No fue posible leer el journal.', { cause: error });
  }

  if (raw.length === 0) return [];
  if (raw[raw.length - 1] !== 0x0a) invalid('Journal truncado: falta newline final.');

  return raw.toString('utf8').slice(0, -1).split('\n').map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
      return invalid(`Registro de journal inválido en línea ${lineNumber}.`);
    }
    try {
      return parseRecord(JSON.parse(line), lineNumber);
    } catch (error) {
      if (error instanceof DurableJournalError) throw error;
      return invalid(`Registro corrupto en línea ${lineNumber}.`, error);
    }
  });
}
function recoverRecords(records: readonly JournalRecord[]): RecoveredJournal {
  const orders: ExecutionOrder[] = [];
  const events: ExecutionEvent[] = [];
  const ordersById = new Map<string, ExecutionOrder>();
  const eventsById = new Map<string, ExecutionEvent>();
  const lastEventByOrder = new Map<string, ExecutionEvent>();

  for (const record of records) {
    if (record.kind === 'order') {
      const existing = ordersById.get(record.payload.order_id);
      if (existing) {
        try {
          assertIdempotentOrder(existing, record.payload);
        } catch (error) {
          invalid('Journal contiene un order_id conflictivo.', error);
        }
        continue;
      }
      ordersById.set(record.payload.order_id, record.payload);
      orders.push(record.payload);
      continue;
    }

    const event = record.payload;
    const duplicate = eventsById.get(event.event_id);
    if (duplicate) {
      if (stableSha256(duplicate) !== stableSha256(event)) {
        invalid('Journal contiene un event_id conflictivo.');
      }
      continue;
    }

    const order = ordersById.get(event.order_id);
    if (!order) invalid('Journal contiene un evento sin orden previa.');

    try {
      const previous = lastEventByOrder.get(event.order_id);
      if (previous) assertEventTransition(previous, event);
      else assertInitialEventMatchesOrder(order, event);
    } catch (error) {
      invalid('Journal contiene una secuencia de eventos inválida.', error);
    }

    eventsById.set(event.event_id, event);
    lastEventByOrder.set(event.order_id, event);
    events.push(event);
  }

  return { orders, events };
}

function appendRecord(path: string, record: JournalRecord): void {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (encoded.length > MAX_RECORD_BYTES) invalid('Registro de journal excede el límite permitido.');

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'a', 0o600);
    writeSync(descriptor, encoded, 0, encoded.length, null);
    fsyncSync(descriptor);
  } catch (error) {
    throw new DurableJournalError('journal_io', 'No fue posible persistir el journal.', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export class DurableJournal {
  readonly #path: string;

  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new TypeError('Ruta de journal inválida.');
    }
    this.#path = path;
  }

  recover(): RecoveredJournal {
    return recoverRecords(readRecords(this.#path));
  }

  recoverExecution(orderIdInput: unknown): RecoveredExecution | null {
    const orderId = uuid(orderIdInput, 'order_id');
    const recovered = this.recover();
    const order = recovered.orders.find((candidate) => candidate.order_id === orderId);
    if (!order) return null;

    const events = Object.freeze(
      recovered.events.filter((event) => event.order_id === orderId),
    );
    const lastEvent = events.at(-1) ?? null;
    const recovery = lastEvent === null || lastEvent.state === 'accepted'
      ? 'accepted'
      : TERMINAL_EXECUTION_STATES.has(lastEvent.state)
        ? 'terminal'
        : 'interrupted';

    return Object.freeze({
      order,
      events,
      last_event: lastEvent,
      recovery,
    });
  }

  appendOrder(input: unknown): ExecutionOrder {
    const incoming = parseExecutionOrder(input);
    const recovered = this.recover();
    const existing = recovered.orders.find((order) => order.order_id === incoming.order_id);
    if (existing) {
      assertIdempotentOrder(existing, incoming);
      return existing;
    }

    appendRecord(this.#path, { version: 1, kind: 'order', payload: incoming });
    return incoming;
  }

  appendEvent(input: unknown): ExecutionEvent {
    const incoming = parseExecutionEvent(input);
    const recovered = this.recover();
    const duplicate = recovered.events.find((event) => event.event_id === incoming.event_id);
    if (duplicate) {
      if (stableSha256(duplicate) !== stableSha256(incoming)) {
        invalid('Reuso conflictivo de event_id.');
      }
      return duplicate;
    }

    const order = recovered.orders.find((candidate) => candidate.order_id === incoming.order_id);
    if (!order) invalid('No se puede persistir un evento sin su orden.');
    const previous = [...recovered.events].reverse().find((event) => event.order_id === incoming.order_id);
    if (previous) assertEventTransition(previous, incoming);
    else assertInitialEventMatchesOrder(order, incoming);

    appendRecord(this.#path, { version: 1, kind: 'event', payload: incoming });
    return incoming;
  }
}
