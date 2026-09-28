import type { ExecutionOrder } from './order.ts';
import { asRecord, exactKeys, integer, noSensitiveText, ref, slug, stringValue, uuid } from './validation.ts';

export type ExecutionState =
  | 'accepted'
  | 'started'
  | 'heartbeat'
  | 'progress'
  | 'checkpoint'
  | 'waiting_human'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type ExecutionEvidence = {
  code: string;
  summary: string;
  ref: string | null;
};

export type ExecutionEvent = {
  version: 1;
  event_id: string;
  order_id: string;
  runner_id: string;
  sequence: number;
  state: ExecutionState;
  occurred_at: number;
  evidence: ExecutionEvidence;
};

const EVENT_KEYS = [
  'version',
  'event_id',
  'order_id',
  'runner_id',
  'sequence',
  'state',
  'occurred_at',
  'evidence',
] as const;

const STATES = new Set<ExecutionState>([
  'accepted',
  'started',
  'heartbeat',
  'progress',
  'checkpoint',
  'waiting_human',
  'blocked',
  'failed',
  'completed',
  'cancelled',
]);

const TRANSITIONS: Record<ExecutionState, ReadonlySet<ExecutionState>> = {
  accepted: new Set(['started', 'cancelled', 'failed']),
  started: new Set(['heartbeat', 'progress', 'checkpoint', 'waiting_human', 'blocked', 'failed', 'completed', 'cancelled']),
  heartbeat: new Set(['heartbeat', 'progress', 'checkpoint', 'waiting_human', 'blocked', 'failed', 'completed', 'cancelled']),
  progress: new Set(['heartbeat', 'progress', 'checkpoint', 'waiting_human', 'blocked', 'failed', 'completed', 'cancelled']),
  checkpoint: new Set(['heartbeat', 'progress', 'checkpoint', 'waiting_human', 'blocked', 'failed', 'completed', 'cancelled']),
  waiting_human: new Set(['started', 'cancelled', 'failed']),
  blocked: new Set(['started', 'cancelled', 'failed']),
  failed: new Set(),
  completed: new Set(),
  cancelled: new Set(),
};

function githubEvidenceRef(raw: string): string {
  if (!raw.startsWith('https://') || raw.includes('\\')) {
    throw new TypeError('evidence.ref no permitido.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('evidence.ref no permitido.');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('evidence.ref no permitido.');
  }

  const pathStart = raw.indexOf('/', 'https://'.length);
  let decodedPath = pathStart === -1 ? '/' : raw.slice(pathStart);
  try {
    for (let depth = 0; depth < 3 && decodedPath.includes('%'); depth += 1) {
      decodedPath = decodeURIComponent(decodedPath);
    }
  } catch {
    throw new TypeError('evidence.ref no permitido.');
  }

  if (decodedPath.includes('%')) throw new TypeError('evidence.ref no permitido.');
  const segments = decodedPath.split('/');
  if (segments.includes('.') || segments.includes('..')) {
    throw new TypeError('evidence.ref no permitido.');
  }

  noSensitiveText(decodedPath, 'evidence.ref');
  return raw;
}

function evidenceRef(input: unknown): string | null {
  if (input === null) return null;
  const raw = noSensitiveText(stringValue(input, 'evidence.ref', 512), 'evidence.ref');
  if (raw.startsWith('controlbot:')) return ref(raw, 'evidence.ref', 512);
  return githubEvidenceRef(raw);
}

function parseEvidence(input: unknown): ExecutionEvidence {
  const record = asRecord(input, 'evidence');
  exactKeys(record, ['code', 'summary', 'ref'], 'evidence');
  return {
    code: slug(record.code, 'evidence.code'),
    summary: noSensitiveText(stringValue(record.summary, 'evidence.summary', 500), 'evidence.summary'),
    ref: evidenceRef(record.ref),
  };
}

export function parseExecutionEvent(input: unknown): ExecutionEvent {
  const record = asRecord(input, 'ExecutionEvent');
  exactKeys(record, EVENT_KEYS, 'ExecutionEvent');
  if (record.version !== 1) throw new TypeError('Versión de ExecutionEvent no soportada.');
  if (typeof record.state !== 'string' || !STATES.has(record.state as ExecutionState)) {
    throw new TypeError('Estado de ejecución inválido.');
  }

  return {
    version: 1,
    event_id: uuid(record.event_id, 'event_id'),
    order_id: uuid(record.order_id, 'order_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    sequence: integer(record.sequence, 'sequence', 1),
    state: record.state as ExecutionState,
    occurred_at: integer(record.occurred_at, 'occurred_at'),
    evidence: parseEvidence(record.evidence),
  };
}

export function assertInitialEventMatchesOrder(order: ExecutionOrder, event: ExecutionEvent): void {
  if (event.order_id !== order.order_id || event.runner_id !== order.runner_id) {
    throw new TypeError('Evento pertenece a otra orden o runner.');
  }
  if (event.sequence !== 1 || event.state !== 'accepted') {
    throw new TypeError('Primer evento inválido.');
  }
  if (event.occurred_at < order.issued_at || event.occurred_at >= order.expires_at) {
    throw new TypeError('Primer evento fuera de la ventana de la orden.');
  }
}

export function assertEventTransition(previous: ExecutionEvent, next: ExecutionEvent): void {
  if (previous.order_id !== next.order_id || previous.runner_id !== next.runner_id) {
    throw new TypeError('Evento pertenece a otra ejecución.');
  }
  if (next.sequence !== previous.sequence + 1) throw new TypeError('Secuencia de eventos inválida.');
  if (next.occurred_at < previous.occurred_at) throw new TypeError('Timestamp de evento regresivo.');
  if (!TRANSITIONS[previous.state].has(next.state)) {
    throw new TypeError(`Transición inválida: ${previous.state} -> ${next.state}.`);
  }
}
