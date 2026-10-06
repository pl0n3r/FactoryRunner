import { HttpSessionClientError, type HttpSessionClientResult } from './http-session-client.ts';
import type { ControlBotRunnerHttpPath } from './http-protocol-v1.ts';
import { asRecord, exactKeys, integer, stableSha256 } from '../validation.ts';

export type HttpSessionEvidenceOutcome =
  | 'http_success'
  | 'client_disabled'
  | 'transport_timeout'
  | 'transport_failed';

type EvidenceSafety = Readonly<{
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
}>;

export type HttpSessionSuccessEvidence = EvidenceSafety & Readonly<{
  version: 1;
  outcome: 'http_success';
  path: ControlBotRunnerHttpPath;
  status: number;
  request_fingerprint: string;
  response_fingerprint: string;
  evidence_fingerprint: string;
}>;

export type HttpSessionErrorEvidence = EvidenceSafety & Readonly<{
  version: 1;
  outcome: Exclude<HttpSessionEvidenceOutcome, 'http_success'>;
  evidence_fingerprint: string;
}>;

export type HttpSessionEvidence = HttpSessionSuccessEvidence | HttpSessionErrorEvidence;

const RESULT_FIELDS = Object.freeze([
  'version',
  'path',
  'status',
  'request_fingerprint',
  'response_fingerprint',
  'body',
  'transport_mode',
  'authority',
  'execution',
  'network_access',
  'external_mutation',
]);
const HTTP_PATHS = new Set<ControlBotRunnerHttpPath>([
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
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_BYTES = 1_024;
const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

function pathValue(value: unknown): ControlBotRunnerHttpPath {
  if (typeof value !== 'string' || !HTTP_PATHS.has(value as ControlBotRunnerHttpPath)) {
    throw new TypeError('HttpSessionClientResult path inválido.');
  }
  return value as ControlBotRunnerHttpPath;
}

function fingerprintValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new TypeError(`${label} inválido.`);
  }
  return value;
}

function assertSafety(record: Record<string, unknown>): void {
  if (
    record.transport_mode !== 'injected_test_only'
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('HttpSessionClientResult safety inválida.');
  }
}

function boundedEvidence<T extends Record<string, unknown>>(
  core: T,
): Readonly<T & { evidence_fingerprint: string }> {
  const evidence = Object.freeze({
    ...core,
    evidence_fingerprint: stableSha256(core),
  });
  const serialized = JSON.stringify(evidence);
  if (new TextEncoder().encode(serialized).byteLength > MAX_EVIDENCE_BYTES) {
    throw new TypeError('HttpSessionEvidence excede el límite de bytes.');
  }
  return evidence;
}

function successEvidence(input: unknown): HttpSessionSuccessEvidence {
  const record = asRecord(input, 'HttpSessionClientResult');
  exactKeys(record, RESULT_FIELDS, 'HttpSessionClientResult');
  if (record.version !== 1) throw new TypeError('HttpSessionClientResult version inválida.');
  assertSafety(record);

  const path = pathValue(record.path);
  const status = integer(record.status, 'status', 200, 299);
  const requestFingerprint = fingerprintValue(record.request_fingerprint, 'request_fingerprint');
  const responseFingerprint = fingerprintValue(record.response_fingerprint, 'response_fingerprint');
  const body = asRecord(record.body, 'body');
  if (stableSha256(body) !== responseFingerprint) {
    throw new TypeError('HttpSessionClientResult response_fingerprint inconsistente.');
  }

  return boundedEvidence({
    version: 1 as const,
    outcome: 'http_success' as const,
    path,
    status,
    request_fingerprint: requestFingerprint,
    response_fingerprint: responseFingerprint,
    ...SAFETY,
  });
}

function errorEvidence(error: HttpSessionClientError): HttpSessionErrorEvidence {
  const code = error.code;
  if (!ERROR_OUTCOMES.has(code)) {
    throw new TypeError('HttpSessionClientError code inválido.');
  }
  return boundedEvidence({
    version: 1 as const,
    outcome: code,
    ...SAFETY,
  });
}

export function httpSessionEvidence(
  input: HttpSessionClientResult | HttpSessionClientError | unknown,
): HttpSessionEvidence {
  if (input instanceof HttpSessionClientError) return errorEvidence(input);
  return successEvidence(input);
}
