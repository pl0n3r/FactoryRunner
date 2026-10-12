import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
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

/** Deniega symlinks en el componente final y FIFOs potencialmente bloqueantes. */
function journalOpenFlags(base: number): number {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    invalid('El entorno no permite abrir el journal de forma segura.');
  }
  return base | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function regularJournalSize(descriptor: number): number {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) invalid('El journal no es un archivo regular.');
  return stat.size;
}

/** Read at most 16 MiB + 1 byte from the verified descriptor, including after fstat. */
function boundedJournalBytes(descriptor: number): Buffer {
  if (regularJournalSize(descriptor) > MAX_JOURNAL_BYTES) invalid('Journal excede el límite permitido.');
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_JOURNAL_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_JOURNAL_BYTES + 1 - total));
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > MAX_JOURNAL_BYTES) invalid('Journal excede el límite permitido.');
    chunks.push(chunk.subarray(0, count));
  }
  return invalid('Journal excede el límite permitido.');
}

function readRecords(path: string): JournalRecord[] {
  let descriptor: number | undefined;
  let raw: Buffer;
  try {
    descriptor = openSync(path, journalOpenFlags(constants.O_RDONLY));
    raw = boundedJournalBytes(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    if (error instanceof DurableJournalError) throw error;
    throw new DurableJournalError('journal_io', 'No fue posible leer el journal.', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  if (raw.length === 0) return [];
  if (raw[raw.length - 1] !== 0x0a) invalid('Journal truncado: falta newline final.');

  // Reject malformed bytes before JSON.parse can silently receive U+FFFD.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return invalid('Journal contiene UTF-8 inválido.');
  }
  return text.slice(0, -1).split('\n').map((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
      return invalid(`Registro de journal inválido en línea ${lineNumber}.`);
    }
    try {
      const decoded: unknown = JSON.parse(line);
      // The append-only writer emits compact JSON.stringify records.
      // Reject duplicate keys (including nested declarations), alternate
      // escapes and whitespace rather than accepting JSON.parse's last value.
      if (JSON.stringify(decoded) !== line) {
        return invalid(`Registro de journal no canónico en línea ${lineNumber}.`);
      }
      return parseRecord(decoded, lineNumber);
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
    descriptor = openSync(path, journalOpenFlags(constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT), 0o600);
    // The same descriptor is checked before writing; no oversized journal may be persisted.
    // This assumes one writer; interprocess serialization is outside this contract.
    if (regularJournalSize(descriptor) > MAX_JOURNAL_BYTES - encoded.length) {
      invalid('Journal excede el límite permitido.');
    }
    // A successful POSIX write may still persist fewer bytes than requested.
    // Never acknowledge a record until every byte is written and fsynced.
    let written = 0;
    while (written < encoded.length) {
      const remaining = encoded.length - written;
      const count = writeSync(descriptor, encoded, written, remaining, null);
      if (!Number.isInteger(count) || count <= 0 || count > remaining) {
        throw new DurableJournalError('journal_io', 'Escritura incompleta del journal.');
      }
      written += count;
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof DurableJournalError) throw error;
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
