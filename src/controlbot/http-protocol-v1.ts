import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
  ref,
  slug,
  stringValue,
  uuid,
  type JsonRecord,
} from '../validation.ts';

export type ControlBotRunnerHttpPath =
  | '/v1/runner/heartbeat'
  | '/v1/runner/poll'
  | '/v1/runner/ack'
  | '/v1/runner/event';

export type ControlBotRunnerHttpEnvelope = Readonly<{
  version: 1;
  method: 'POST';
  path: ControlBotRunnerHttpPath;
  payload: Readonly<Record<string, unknown>>;
}>;

export type ControlBotRunnerHttpContractResult = Readonly<{
  version: 1;
  method: 'POST';
  path: ControlBotRunnerHttpPath;
  payload: Readonly<Record<string, unknown>>;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

const ENVELOPE_FIELDS = Object.freeze(['version', 'method', 'path', 'payload']);
const MAX_ENVELOPE_BYTES = 65_536;
const MAX_PAYLOAD_BYTES = 32_768;
const MAX_COLLECTION_ITEMS = 128;
const MAX_DEPTH = 8;
const MAX_GENERATION = 1_000_000_000;
const HEARTBEAT_STATES = new Set(['ready', 'busy', 'draining', 'offline']);
const EXECUTION_STATES = new Set([
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

const SECRET_KEY_RE =
  /(?:^|[_-])(?:password|passwd|token|secret|cookie|authorization|private[_-]?key|api[_-]?key|dsn)(?:$|[_-])/i;

const RESULT_SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function jsonBytes(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} no es JSON-safe.`);
  }
  if (serialized === undefined) throw new TypeError(`${label} no es JSON-safe.`);
  return new TextEncoder().encode(serialized).byteLength;
}

function assertJsonBounded(value: unknown, maxBytes: number, label: string): void {
  if (jsonBytes(value, label) > maxBytes) throw new TypeError(`${label} excede el límite de bytes.`);
}

function assertSecretFree(value: unknown, label = 'payload', depth = 0): void {
  if (depth > MAX_DEPTH) throw new TypeError(`${label} excede la profundidad permitida.`);

  if (typeof value === 'string') {
    noSensitiveText(value, label);
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;

  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      throw new TypeError(`${label} excede el máximo de elementos.`);
    }
    value.forEach((item, index) => assertSecretFree(item, `${label}[${index}]`, depth + 1));
    return;
  }

  if (typeof value !== 'object') throw new TypeError(`${label} contiene un valor no permitido.`);

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COLLECTION_ITEMS) {
    throw new TypeError(`${label} excede el máximo de campos.`);
  }
  for (const [key, item] of entries) {
    if (SECRET_KEY_RE.test(key)) throw new TypeError(`${label} contiene un campo sensible.`);
    assertSecretFree(item, `${label}.${key}`, depth + 1);
  }
}

function pathValue(value: unknown): ControlBotRunnerHttpPath {
  const path = stringValue(value, 'path', 64);
  if (
    path !== '/v1/runner/heartbeat'
    && path !== '/v1/runner/poll'
    && path !== '/v1/runner/ack'
    && path !== '/v1/runner/event'
  ) {
    throw new TypeError('Ruta Runner HTTP V1 inválida.');
  }
  return path;
}

function uniqueRefs(value: unknown, label: string, limit: number): readonly string[] {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError(`${label} inválido.`);
  const parsed = value.map((item, index) => ref(item, `${label}[${index}]`, 160));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${label} contiene duplicados.`);
  return Object.freeze([...parsed].sort((left, right) => left.localeCompare(right, 'en')));
}

function parseHeartbeat(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value, 'RunnerHeartbeat');
  exactKeys(
    record,
    ['version', 'runner_id', 'sequence', 'observed_at', 'status', 'capacity', 'active_sessions'],
    'RunnerHeartbeat',
  );
  if (record.version !== 1) throw new TypeError('RunnerHeartbeat version inválida.');

  const status = stringValue(record.status, 'status', 16);
  if (!HEARTBEAT_STATES.has(status)) throw new TypeError('RunnerHeartbeat status inválido.');

  const capacity = asRecord(record.capacity, 'capacity');
  exactKeys(capacity, ['max', 'active'], 'capacity');
  const max = integer(capacity.max, 'capacity.max', 1, 64);
  const active = integer(capacity.active, 'capacity.active', 0, max);
  const activeSessions = uniqueRefs(record.active_sessions, 'active_sessions', 64);
  if (activeSessions.length > active) throw new TypeError('active_sessions inconsistente.');

  return Object.freeze({
    version: 1,
    runner_id: uuid(record.runner_id, 'runner_id'),
    sequence: integer(record.sequence, 'sequence'),
    observed_at: integer(record.observed_at, 'observed_at'),
    status,
    capacity: Object.freeze({ max, active }),
    active_sessions: activeSessions,
  });
}

function parsePoll(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value, 'RunnerPoll');
  exactKeys(record, ['version', 'runner_id', 'session_id', 'generation', 'requested_at'], 'RunnerPoll');
  if (record.version !== 1) throw new TypeError('RunnerPoll version inválida.');

  return Object.freeze({
    version: 1,
    runner_id: uuid(record.runner_id, 'runner_id'),
    session_id: ref(record.session_id, 'session_id', 160),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    requested_at: integer(record.requested_at, 'requested_at'),
  });
}

function parseAck(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value, 'RunnerAck');
  exactKeys(
    record,
    ['version', 'order_id', 'attempt_id', 'runner_id', 'generation', 'acknowledged_at'],
    'RunnerAck',
  );
  if (record.version !== 1) throw new TypeError('RunnerAck version inválida.');

  return Object.freeze({
    version: 1,
    order_id: uuid(record.order_id, 'order_id'),
    attempt_id: uuid(record.attempt_id, 'attempt_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    acknowledged_at: integer(record.acknowledged_at, 'acknowledged_at'),
  });
}

function safeEvidenceRef(value: unknown): string | null {
  if (value === null) return null;
  const raw = noSensitiveText(stringValue(value, 'evidence.ref', 512), 'evidence.ref');

  if (raw.startsWith('controlbot:')) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/.test(raw)) {
      throw new TypeError('evidence.ref inválida.');
    }
    return raw;
  }

  if (!raw.startsWith('https://') || raw.includes('\\')) throw new TypeError('evidence.ref inválida.');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('evidence.ref inválida.');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new TypeError('evidence.ref inválida.');
  }

  let decodedPath = parsed.pathname;
  try {
    for (let depth = 0; depth < 3 && decodedPath.includes('%'); depth += 1) {
      decodedPath = decodeURIComponent(decodedPath);
    }
  } catch {
    throw new TypeError('evidence.ref inválida.');
  }
  if (decodedPath.includes('%') || decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('evidence.ref inválida.');
  }
  noSensitiveText(decodedPath, 'evidence.ref');
  return raw;
}

function parseEvent(value: unknown): Readonly<Record<string, unknown>> {
  const record = asRecord(value, 'ExecutionEvent');
  exactKeys(
    record,
    [
      'version',
      'event_id',
      'order_id',
      'attempt_id',
      'runner_id',
      'generation',
      'sequence',
      'state',
      'occurred_at',
      'evidence',
    ],
    'ExecutionEvent',
  );
  if (record.version !== 1) throw new TypeError('ExecutionEvent version inválida.');

  const state = stringValue(record.state, 'state', 32);
  if (!EXECUTION_STATES.has(state)) throw new TypeError('ExecutionEvent state inválido.');

  const evidence = asRecord(record.evidence, 'evidence');
  exactKeys(evidence, ['code', 'summary', 'ref'], 'evidence');

  return Object.freeze({
    version: 1,
    event_id: uuid(record.event_id, 'event_id'),
    order_id: uuid(record.order_id, 'order_id'),
    attempt_id: uuid(record.attempt_id, 'attempt_id'),
    runner_id: uuid(record.runner_id, 'runner_id'),
    generation: integer(record.generation, 'generation', 1, MAX_GENERATION),
    sequence: integer(record.sequence, 'sequence', 1),
    state,
    occurred_at: integer(record.occurred_at, 'occurred_at', 1),
    evidence: Object.freeze({
      code: slug(evidence.code, 'evidence.code'),
      summary: noSensitiveText(stringValue(evidence.summary, 'evidence.summary', 500), 'evidence.summary'),
      ref: safeEvidenceRef(evidence.ref),
    }),
  });
}

function parsePayload(path: ControlBotRunnerHttpPath, payload: JsonRecord): Readonly<Record<string, unknown>> {
  switch (path) {
    case '/v1/runner/heartbeat':
      return parseHeartbeat(payload);
    case '/v1/runner/poll':
      return parsePoll(payload);
    case '/v1/runner/ack':
      return parseAck(payload);
    case '/v1/runner/event':
      return parseEvent(payload);
  }
}

export function controlBotRunnerHttpRequest(input: unknown): ControlBotRunnerHttpContractResult {
  const envelope = asRecord(input, 'RunnerHttpEnvelope');
  exactKeys(envelope, ENVELOPE_FIELDS, 'RunnerHttpEnvelope');
  assertJsonBounded(envelope, MAX_ENVELOPE_BYTES, 'RunnerHttpEnvelope');

  if (envelope.version !== 1 || envelope.method !== 'POST') {
    throw new TypeError('RunnerHttpEnvelope version/method inválido.');
  }

  const path = pathValue(envelope.path);
  const payload = asRecord(envelope.payload, 'RunnerHttpPayload');
  assertJsonBounded(payload, MAX_PAYLOAD_BYTES, 'RunnerHttpPayload');
  assertSecretFree(envelope, 'RunnerHttpEnvelope');

  return Object.freeze({
    version: 1,
    method: 'POST',
    path,
    payload: parsePayload(path, payload),
    ...RESULT_SAFETY,
  });
}
