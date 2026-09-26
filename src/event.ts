import { asRecord, exactKeys, integer, noSensitiveText, slug, stringValue, uuid } from './validation.ts';

export type ExecutionState = 'accepted' | 'started' | 'heartbeat' | 'progress' | 'checkpoint' | 'waiting_human' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type ExecutionEvidence = { code: string; summary: string; ref: string | null };
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

const EVENT_KEYS = ['version','event_id','order_id','runner_id','sequence','state','occurred_at','evidence'] as const;
const STATES = new Set<ExecutionState>(['accepted','started','heartbeat','progress','checkpoint','waiting_human','blocked','failed','completed','cancelled']);
const TRANSITIONS: Record<ExecutionState, ReadonlySet<ExecutionState>> = {
  accepted: new Set(['started','cancelled','failed']),
  started: new Set(['heartbeat','progress','checkpoint','waiting_human','blocked','failed','completed','cancelled']),
  heartbeat: new Set(['heartbeat','progress','checkpoint','waiting_human','blocked','failed','completed','cancelled']),
  progress: new Set(['heartbeat','progress','checkpoint','waiting_human','blocked','failed','completed','cancelled']),
  checkpoint: new Set(['heartbeat','progress','checkpoint','waiting_human','blocked','failed','completed','cancelled']),
  waiting_human: new Set(['started','cancelled','failed']),
  blocked: new Set(['started','cancelled','failed']),
  failed: new Set(),
  completed: new Set(),
  cancelled: new Set(),
};

function evidenceRecord(input: unknown): ExecutionEvidence {
  const record = asRecord(input, 'evidence');
  exactKeys(record, ['code','summary','ref'], 'evidence');
  const summary = noSensitiveText(stringValue(record.summary, 'evidence.summary', 500), 'evidence.summary');
  let evidenceRef: string | null = null;
  if (record.ref !== null) {
    evidenceRef = noSensitiveText(
      stringValue(record.ref, 'evidence.ref', 512),
      'evidence.ref',
    );
    let checkedRef = evidenceRef;
    if (evidenceRef.startsWith('https://')) {
      let parsed: URL;
      let rawPath = '';
      if (evidenceRef.includes('\\')) throw new TypeError('evidence.ref no permitido.');
      try {
        const rawMatch = /^https:\/\/[^/?#]+([^?#]*)/.exec(evidenceRef);
        if (!rawMatch) throw new TypeError('evidence.ref no permitido.');
        rawPath = rawMatch[1] || '/';
        checkedRef = rawPath;
        for (let depth = 0; depth < 3 && checkedRef.includes('%'); depth += 1) {
          checkedRef = decodeURIComponent(checkedRef);
        }
        if (checkedRef.includes('%')) throw new TypeError('evidence.ref no permitido.');
        parsed = new URL(evidenceRef);
      } catch {
        throw new TypeError('evidence.ref no permitido.');
      }
      const rawSegments = checkedRef.split('/');
      const canonicalPath = decodeURIComponent(parsed.pathname);
      const canonicalSegments = canonicalPath.split('/');
      if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== 'github.com' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.search !== '' ||
        parsed.hash !== '' ||
        rawSegments.includes('.') ||
        rawSegments.includes('..') ||
        canonicalSegments.includes('.') ||
        canonicalSegments.includes('..') ||
        canonicalPath.includes('%')
      ) {
        throw new TypeError('evidence.ref no permitido.');
      }
      noSensitiveText(checkedRef, 'evidence.ref');
      noSensitiveText(canonicalPath, 'evidence.ref');
    } else if (!evidenceRef.startsWith('controlbot:')) {
      throw new TypeError('evidence.ref no permitido.');
    }
  }
  return { code: slug(record.code, 'evidence.code'), summary, ref: evidenceRef };
}

export function parseExecutionEvent(input: unknown): ExecutionEvent {
  const record = asRecord(input, 'ExecutionEvent');
  exactKeys(record, EVENT_KEYS, 'ExecutionEvent');
  if (record.version !== 1) throw new TypeError('Versión de ExecutionEvent no soportada.');
  if (typeof record.state !== 'string' || !STATES.has(record.state as ExecutionState)) throw new TypeError('Estado de ejecución inválido.');
  return {
    version: 1,
    event_id: uuid(record.event_id, 'event_id'),
    order_id: uuid(record.order_id, 'order_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    sequence: integer(record.sequence, 'sequence', 1),
    state: record.state as ExecutionState,
    occurred_at: integer(record.occurred_at, 'occurred_at'),
    evidence: evidenceRecord(record.evidence),
  };
}

export function assertEventTransition(previous: ExecutionEvent, next: ExecutionEvent): void {
  if (previous.order_id !== next.order_id || previous.runner_id !== next.runner_id) throw new TypeError('Evento pertenece a otra ejecución.');
  if (next.sequence !== previous.sequence + 1) throw new TypeError('Secuencia de eventos inválida.');
  if (next.occurred_at < previous.occurred_at) throw new TypeError('Timestamp de evento regresivo.');
  if (!TRANSITIONS[previous.state].has(next.state)) throw new TypeError(`Transición inválida: ${previous.state} -> ${next.state}.`);
}
