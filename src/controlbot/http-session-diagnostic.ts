import type { HttpSessionClientStatus } from './http-session-client.ts';
import {
  HttpSessionEvidenceLedger,
  type HttpSessionEvidenceLedgerSnapshot,
} from './http-session-evidence-ledger.ts';
import type {
  ControlBotHttpPublicCompatibility,
  ControlBotHttpPublicCompatibilityReason,
} from '../controlbot-http-public-compatibility.ts';
import { asRecord, exactKeys, integer, stableSha256 } from '../validation.ts';

export type HttpSessionDiagnosticReason =
  | 'COMPATIBILITY_INCOMPATIBLE'
  | 'COMPATIBILITY_INVALID'
  | 'EVIDENCE_NOT_PREPARED'
  | 'LEDGER_EMPTY'
  | 'LEDGER_INVALID'
  | 'LEDGER_STATUS_MISMATCH'
  | 'STATUS_INVALID';

export type HttpSessionDiagnostic = Readonly<{
  version: 1;
  status: 'PREPARED' | 'BLOCKED';
  reasons: readonly HttpSessionDiagnosticReason[];
  status_fingerprint: string | null;
  compatibility_fingerprint: string | null;
  ledger_fingerprint: string | null;
  evidence_count: number;
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

const STATUS_KEYS = Object.freeze([
  'version',
  'enabled',
  'transport_mode',
  'timeout_ms',
  'max_response_bytes',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
]);
const COMPATIBILITY_KEYS = Object.freeze([
  'version',
  'authority',
  'status',
  'reasons',
  'manifest_fingerprint',
  'execution',
  'network_access',
  'external_mutation',
  'fingerprint',
]);
const LEDGER_KEYS = Object.freeze([
  'version',
  'capacity',
  'count',
  'first_sequence',
  'last_sequence',
  'entries',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
  'ledger_fingerprint',
]);
const LEDGER_ENTRY_KEYS = Object.freeze([
  'version',
  'sequence',
  'evidence',
  'entry_fingerprint',
]);
const COMPATIBILITY_REASONS = new Set<ControlBotHttpPublicCompatibilityReason>([
  'CONTRACT_MISSING',
  'CONTRACT_VERSION_MISMATCH',
  'FENCING_MISMATCH',
  'MANIFEST_INVALID',
  'PROTOCOL_MISMATCH',
  'REQUIREMENTS_INVALID',
  'SAFETY_MISMATCH',
  'SESSION_MISMATCH',
  'SUBPATH_MISMATCH',
  'SURFACE_MISMATCH',
  'VERSION_MISMATCH',
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function hashValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new TypeError(`${label} inválido.`);
  }
  return value;
}

function assertSafety(record: Record<string, unknown>, label: string): void {
  if (
    record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError(`${label} safety inválida.`);
  }
}

function canonicalStatus(input: unknown): HttpSessionClientStatus {
  const record = asRecord(input, 'HttpSessionClientStatus');
  exactKeys(record, STATUS_KEYS, 'HttpSessionClientStatus');
  if (record.version !== 1 || typeof record.enabled !== 'boolean') {
    throw new TypeError('HttpSessionClientStatus inválido.');
  }
  assertSafety(record, 'HttpSessionClientStatus');

  const enabled = record.enabled;
  const expectedTransport = enabled ? 'injected_test_only' : 'disabled';
  if (record.transport_mode !== expectedTransport) {
    throw new TypeError('HttpSessionClientStatus transport_mode incoherente.');
  }

  return Object.freeze({
    version: 1,
    enabled,
    transport_mode: expectedTransport,
    timeout_ms: integer(record.timeout_ms, 'timeout_ms', 10, 30_000),
    max_response_bytes: integer(record.max_response_bytes, 'max_response_bytes', 256, 65_536),
    ...SAFETY,
  });
}

function canonicalCompatibility(input: unknown): ControlBotHttpPublicCompatibility {
  const record = asRecord(input, 'ControlBotHttpPublicCompatibility');
  exactKeys(record, COMPATIBILITY_KEYS, 'ControlBotHttpPublicCompatibility');
  if (record.version !== 1 || (record.status !== 'COMPATIBLE' && record.status !== 'INCOMPATIBLE')) {
    throw new TypeError('ControlBotHttpPublicCompatibility inválida.');
  }
  assertSafety(record, 'ControlBotHttpPublicCompatibility');

  if (!Array.isArray(record.reasons) || record.reasons.length > COMPATIBILITY_REASONS.size) {
    throw new TypeError('ControlBotHttpPublicCompatibility reasons inválidas.');
  }
  const reasons = record.reasons.map((reason) => {
    if (typeof reason !== 'string' || !COMPATIBILITY_REASONS.has(reason as ControlBotHttpPublicCompatibilityReason)) {
      throw new TypeError('ControlBotHttpPublicCompatibility reason inválida.');
    }
    return reason as ControlBotHttpPublicCompatibilityReason;
  });
  const orderedReasons = [...new Set(reasons)].sort((left, right) => left.localeCompare(right, 'en'));
  if (
    orderedReasons.length !== reasons.length
    || orderedReasons.some((reason, index) => reason !== reasons[index])
    || (record.status === 'COMPATIBLE' && orderedReasons.length !== 0)
    || (record.status === 'INCOMPATIBLE' && orderedReasons.length === 0)
  ) {
    throw new TypeError('ControlBotHttpPublicCompatibility reasons incoherentes.');
  }

  const manifestFingerprint = record.manifest_fingerprint === null
    ? null
    : hashValue(record.manifest_fingerprint, 'manifest_fingerprint');
  if (record.status === 'COMPATIBLE' && manifestFingerprint === null) {
    throw new TypeError('ControlBotHttpPublicCompatibility manifest_fingerprint ausente.');
  }

  const report = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: record.status,
    reasons: Object.freeze(orderedReasons),
    manifest_fingerprint: manifestFingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = hashValue(record.fingerprint, 'compatibility fingerprint');
  if (stableSha256(report) !== fingerprint) {
    throw new TypeError('ControlBotHttpPublicCompatibility fingerprint inconsistente.');
  }
  return Object.freeze({ ...report, fingerprint });
}

function canonicalLedger(input: unknown): HttpSessionEvidenceLedgerSnapshot {
  const record = asRecord(input, 'HttpSessionEvidenceLedgerSnapshot');
  exactKeys(record, LEDGER_KEYS, 'HttpSessionEvidenceLedgerSnapshot');
  if (!Array.isArray(record.entries)) {
    throw new TypeError('HttpSessionEvidenceLedgerSnapshot entries inválidas.');
  }

  const replay = new HttpSessionEvidenceLedger();
  for (const rawEntry of record.entries) {
    const entry = asRecord(rawEntry, 'HttpSessionEvidenceLedgerEntry');
    exactKeys(entry, LEDGER_ENTRY_KEYS, 'HttpSessionEvidenceLedgerEntry');
    if (entry.version !== 1) throw new TypeError('HttpSessionEvidenceLedgerEntry version inválida.');
    const sequence = integer(entry.sequence, 'sequence', 1);
    const expectedEntryFingerprint = hashValue(entry.entry_fingerprint, 'entry_fingerprint');
    const canonicalEntry = replay.append(sequence, entry.evidence);
    if (canonicalEntry.entry_fingerprint !== expectedEntryFingerprint) {
      throw new TypeError('HttpSessionEvidenceLedgerEntry fingerprint inconsistente.');
    }
  }

  const canonical = replay.snapshot();
  if (stableSha256(record) !== stableSha256(canonical)) {
    throw new TypeError('HttpSessionEvidenceLedgerSnapshot no es canónico.');
  }
  return canonical;
}

function statusLedgerCoherence(
  status: HttpSessionClientStatus,
  ledger: HttpSessionEvidenceLedgerSnapshot,
  reasons: HttpSessionDiagnosticReason[],
): void {
  if (ledger.count === 0) {
    reasons.push('LEDGER_EMPTY');
    return;
  }

  const outcomes = ledger.entries.map(({ evidence }) => evidence.outcome);
  if (!status.enabled) {
    if (outcomes.some((outcome) => outcome !== 'client_disabled')) {
      reasons.push('LEDGER_STATUS_MISMATCH');
    }
    return;
  }

  if (outcomes.some((outcome) => outcome === 'client_disabled')) {
    reasons.push('LEDGER_STATUS_MISMATCH');
  }
  if (outcomes.some((outcome) => outcome !== 'http_success')) {
    reasons.push('EVIDENCE_NOT_PREPARED');
  }
}

function boundedDiagnostic(
  core: Omit<HttpSessionDiagnostic, 'fingerprint'>,
): HttpSessionDiagnostic {
  const diagnostic = Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
  if (new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength > MAX_DIAGNOSTIC_BYTES) {
    throw new TypeError('HttpSessionDiagnostic excede el límite de bytes.');
  }
  return diagnostic;
}

export function httpSessionDiagnostic(
  statusInput: unknown,
  compatibilityInput: unknown,
  ledgerInput: unknown,
): HttpSessionDiagnostic {
  const reasons: HttpSessionDiagnosticReason[] = [];

  let status: HttpSessionClientStatus | null = null;
  let compatibility: ControlBotHttpPublicCompatibility | null = null;
  let ledger: HttpSessionEvidenceLedgerSnapshot | null = null;

  try { status = canonicalStatus(statusInput); }
  catch { reasons.push('STATUS_INVALID'); }
  try { compatibility = canonicalCompatibility(compatibilityInput); }
  catch { reasons.push('COMPATIBILITY_INVALID'); }
  try { ledger = canonicalLedger(ledgerInput); }
  catch { reasons.push('LEDGER_INVALID'); }

  if (compatibility !== null && compatibility.status !== 'COMPATIBLE') {
    reasons.push('COMPATIBILITY_INCOMPATIBLE');
  }
  if (status !== null && ledger !== null) {
    statusLedgerCoherence(status, ledger, reasons);
  }

  const orderedReasons = Object.freeze(
    [...new Set(reasons)].sort((left, right) => left.localeCompare(right, 'en')),
  );
  const core = Object.freeze({
    version: 1 as const,
    status: orderedReasons.length === 0 ? 'PREPARED' as const : 'BLOCKED' as const,
    reasons: orderedReasons,
    status_fingerprint: status === null ? null : stableSha256(status),
    compatibility_fingerprint: compatibility?.fingerprint ?? null,
    ledger_fingerprint: ledger?.ledger_fingerprint ?? null,
    evidence_count: ledger?.count ?? 0,
    ...SAFETY,
  });
  return boundedDiagnostic(core);
}
