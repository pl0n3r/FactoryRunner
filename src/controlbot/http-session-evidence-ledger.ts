import type {
  HttpSessionErrorEvidence,
  HttpSessionEvidence,
  HttpSessionSuccessEvidence,
} from './http-session-evidence.ts';
import { asRecord, exactKeys, integer, stableSha256 } from '../validation.ts';

const LEDGER_CAPACITY = 64 as const;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const HTTP_PATHS = new Set<HttpSessionSuccessEvidence['path']>([
  '/v1/runner/heartbeat',
  '/v1/runner/poll',
  '/v1/runner/ack',
  '/v1/runner/event',
]);
const ERROR_OUTCOMES = new Set<HttpSessionErrorEvidence['outcome']>([
  'client_disabled',
  'transport_timeout',
  'transport_failed',
]);
const SUCCESS_FIELDS = Object.freeze([
  'version',
  'outcome',
  'path',
  'status',
  'request_fingerprint',
  'response_fingerprint',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
  'evidence_fingerprint',
]);
const ERROR_FIELDS = Object.freeze([
  'version',
  'outcome',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
  'evidence_fingerprint',
]);
const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

type LedgerSafety = typeof SAFETY;
type CapturedSafety = Readonly<{
  authority: unknown;
  execution: unknown;
  networkAccess: unknown;
  externalMutation: unknown;
}>;

export type HttpSessionEvidenceLedgerEntry = Readonly<{
  version: 1;
  sequence: number;
  evidence: HttpSessionEvidence;
  entry_fingerprint: string;
}>;

export type HttpSessionEvidenceLedgerSnapshot = LedgerSafety & Readonly<{
  version: 1;
  capacity: typeof LEDGER_CAPACITY;
  count: number;
  first_sequence: number | null;
  last_sequence: number | null;
  entries: readonly HttpSessionEvidenceLedgerEntry[];
  ledger_fingerprint: string;
}>;

function fingerprintValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new TypeError(`${label} inválido.`);
  }
  return value;
}

function captureSafety(record: Record<string, unknown>): CapturedSafety {
  return Object.freeze({
    authority: record.authority,
    execution: record.execution,
    networkAccess: record.network_access,
    externalMutation: record.external_mutation,
  });
}

function assertSafety(safety: CapturedSafety): void {
  if (
    safety.authority !== 'unchanged'
    || safety.execution !== false
    || safety.networkAccess !== false
    || safety.externalMutation !== false
  ) {
    throw new TypeError('HttpSessionEvidence safety inválida.');
  }
}

function canonicalSuccessEvidence(
  record: Record<string, unknown>,
  outcomeInput: unknown,
): HttpSessionSuccessEvidence {
  exactKeys(record, SUCCESS_FIELDS, 'HttpSessionEvidence');

  const version = record.version;
  const pathInput = record.path;
  const statusInput = record.status;
  const requestFingerprintInput = record.request_fingerprint;
  const responseFingerprintInput = record.response_fingerprint;
  const safety = captureSafety(record);
  const evidenceFingerprintInput = record.evidence_fingerprint;

  if (version !== 1 || outcomeInput !== 'http_success') {
    throw new TypeError('HttpSessionEvidence success inválida.');
  }
  assertSafety(safety);

  if (
    typeof pathInput !== 'string'
    || !HTTP_PATHS.has(pathInput as HttpSessionSuccessEvidence['path'])
  ) {
    throw new TypeError('HttpSessionEvidence path inválido.');
  }
  const status = integer(statusInput, 'status', 200, 299);
  const requestFingerprint = fingerprintValue(requestFingerprintInput, 'request_fingerprint');
  const responseFingerprint = fingerprintValue(responseFingerprintInput, 'response_fingerprint');
  const evidenceFingerprint = fingerprintValue(evidenceFingerprintInput, 'evidence_fingerprint');
  const core = {
    version: 1 as const,
    outcome: 'http_success' as const,
    path: pathInput as HttpSessionSuccessEvidence['path'],
    status,
    request_fingerprint: requestFingerprint,
    response_fingerprint: responseFingerprint,
    ...SAFETY,
  };
  if (stableSha256(core) !== evidenceFingerprint) {
    throw new TypeError('HttpSessionEvidence fingerprint inconsistente.');
  }
  return Object.freeze({
    ...core,
    evidence_fingerprint: evidenceFingerprint,
  });
}

function canonicalErrorEvidence(
  record: Record<string, unknown>,
  outcomeInput: unknown,
): HttpSessionErrorEvidence {
  exactKeys(record, ERROR_FIELDS, 'HttpSessionEvidence');

  const version = record.version;
  const safety = captureSafety(record);
  const evidenceFingerprintInput = record.evidence_fingerprint;

  if (
    version !== 1
    || typeof outcomeInput !== 'string'
    || !ERROR_OUTCOMES.has(outcomeInput as HttpSessionErrorEvidence['outcome'])
  ) {
    throw new TypeError('HttpSessionEvidence outcome inválido.');
  }
  assertSafety(safety);

  const outcome = outcomeInput as HttpSessionErrorEvidence['outcome'];
  const evidenceFingerprint = fingerprintValue(evidenceFingerprintInput, 'evidence_fingerprint');
  const core = {
    version: 1 as const,
    outcome,
    ...SAFETY,
  };
  if (stableSha256(core) !== evidenceFingerprint) {
    throw new TypeError('HttpSessionEvidence fingerprint inconsistente.');
  }
  return Object.freeze({
    ...core,
    evidence_fingerprint: evidenceFingerprint,
  });
}

function canonicalEvidence(input: unknown): HttpSessionEvidence {
  const record = asRecord(input, 'HttpSessionEvidence');
  const outcome = record.outcome;
  if (outcome === 'http_success') return canonicalSuccessEvidence(record, outcome);
  return canonicalErrorEvidence(record, outcome);
}

function sameEvidence(left: HttpSessionEvidence, right: HttpSessionEvidence): boolean {
  return left.evidence_fingerprint === right.evidence_fingerprint
    && stableSha256(left) === stableSha256(right);
}

function boundedSnapshot(
  core: Omit<HttpSessionEvidenceLedgerSnapshot, 'ledger_fingerprint'>,
): HttpSessionEvidenceLedgerSnapshot {
  const snapshot = Object.freeze({
    ...core,
    ledger_fingerprint: stableSha256(core),
  });
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new TypeError('HttpSessionEvidenceLedger snapshot excede el límite de bytes.');
  }
  return snapshot;
}

export class HttpSessionEvidenceLedger {
  readonly #entries: HttpSessionEvidenceLedgerEntry[] = [];

  append(sequenceInput: unknown, evidenceInput: unknown): HttpSessionEvidenceLedgerEntry {
    const sequence = integer(sequenceInput, 'sequence', 1);
    const evidence = canonicalEvidence(evidenceInput);
    const existing = this.#entries.find((entry) => entry.sequence === sequence);
    if (existing !== undefined) {
      if (!sameEvidence(existing.evidence, evidence)) {
        throw new TypeError('HttpSessionEvidenceLedger sequence ya tiene evidencia distinta.');
      }
      return existing;
    }

    const last = this.#entries.at(-1);
    const expectedSequence = last === undefined ? 1 : last.sequence + 1;
    if (sequence !== expectedSequence) {
      throw new TypeError('HttpSessionEvidenceLedger sequence fuera de orden.');
    }
    if (this.#entries.length >= LEDGER_CAPACITY) {
      throw new TypeError('HttpSessionEvidenceLedger excede su capacidad.');
    }

    const entryCore = Object.freeze({
      version: 1 as const,
      sequence,
      evidence,
    });
    const entry = Object.freeze({
      ...entryCore,
      entry_fingerprint: stableSha256(entryCore),
    });
    this.#entries.push(entry);
    return entry;
  }

  snapshot(): HttpSessionEvidenceLedgerSnapshot {
    const entries = Object.freeze([...this.#entries]);
    const first = entries[0];
    const last = entries.at(-1);
    return boundedSnapshot({
      version: 1 as const,
      capacity: LEDGER_CAPACITY,
      count: entries.length,
      first_sequence: first?.sequence ?? null,
      last_sequence: last?.sequence ?? null,
      entries,
      ...SAFETY,
    });
  }
}
