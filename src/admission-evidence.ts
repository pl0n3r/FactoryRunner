import type {
  ExecutionAdmissionDecision,
  ExecutionAdmissionState,
} from './execution-admission.ts';
import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
  ref,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type AdmissionEvidence = {
  version: 1;
  decision: ExecutionAdmissionState;
  authority: 'unchanged';
  runner_id: string | null;
  order_id: string | null;
  work_item_id: string | null;
  observed_at: number | null;
  reasons: readonly string[];
  order_fingerprint: string | null;
  manifest_fingerprint: string | null;
  resource_fingerprint: string | null;
  decision_fingerprint: string;
  fingerprint: string;
};

type AdmissionEvidenceCore = Omit<AdmissionEvidence, 'fingerprint'>;
type DecisionCore = Omit<ExecutionAdmissionDecision, 'fingerprint'>;

const DECISION_KEYS = [
  'version',
  'decision',
  'authority',
  'runner_id',
  'order_id',
  'work_item_id',
  'observed_at',
  'order_fingerprint',
  'manifest_fingerprint',
  'resource_fingerprint',
  'reasons',
  'fingerprint',
] as const;

const STATES = new Set<ExecutionAdmissionState>([
  'ALLOW',
  'WAIT_CAPACITY',
  'BLOCKED',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_REASONS = 16;

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function nullableRef(value: unknown, field: string): string | null {
  return value === null ? null : ref(value, field, 160);
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
  return parsed;
}

function nullableSha256(value: unknown, field: string): string | null {
  return value === null ? null : sha256(value, field);
}

function parseReasons(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REASONS) {
    throw new TypeError('Admission reasons inválidas.');
  }

  const reasons = input.map((value, index) => {
    const reason = noSensitiveText(
      stringValue(value, `reasons[${index}]`, 80),
      `reasons[${index}]`,
    );
    if (!REASON_RE.test(reason)) {
      throw new TypeError('Admission reason inválida.');
    }
    return reason;
  });

  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError('Admission reasons duplicadas.');
  }

  const sorted = [...reasons].sort((left, right) => left.localeCompare(right, 'en'));
  if (sorted.some((value, index) => value !== reasons[index])) {
    throw new TypeError('Admission reasons deben ser canónicas.');
  }

  return Object.freeze(sorted);
}

function parseDecision(input: unknown): ExecutionAdmissionDecision {
  const record = asRecord(input, 'ExecutionAdmissionDecision');
  exactKeys(record, DECISION_KEYS, 'ExecutionAdmissionDecision');

  if (record.version !== 1) {
    throw new TypeError('ExecutionAdmissionDecision version inválida.');
  }
  if (typeof record.decision !== 'string' || !STATES.has(record.decision as ExecutionAdmissionState)) {
    throw new TypeError('ExecutionAdmissionDecision state inválido.');
  }
  if (record.authority !== 'unchanged') {
    throw new TypeError('Admission authority no puede ampliarse.');
  }

  const decision = record.decision as ExecutionAdmissionState;
  const runnerId = nullableUuid(record.runner_id, 'runner_id');
  const orderId = nullableUuid(record.order_id, 'order_id');
  const workItemId = nullableRef(record.work_item_id, 'work_item_id');
  const observedAt = nullableInteger(record.observed_at, 'observed_at');
  const orderFingerprint = nullableSha256(record.order_fingerprint, 'order_fingerprint');
  const manifestFingerprint = nullableSha256(
    record.manifest_fingerprint,
    'manifest_fingerprint',
  );
  const resourceFingerprint = nullableSha256(
    record.resource_fingerprint,
    'resource_fingerprint',
  );
  const reasons = parseReasons(record.reasons);
  const fingerprint = sha256(record.fingerprint, 'fingerprint');

  const core: DecisionCore = {
    version: 1,
    decision,
    authority: 'unchanged',
    runner_id: runnerId,
    order_id: orderId,
    work_item_id: workItemId,
    observed_at: observedAt,
    order_fingerprint: orderFingerprint,
    manifest_fingerprint: manifestFingerprint,
    resource_fingerprint: resourceFingerprint,
    reasons: [...reasons],
  };

  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionAdmissionDecision fingerprint incoherente.');
  }

  const fullProvenance = [
    runnerId,
    orderId,
    workItemId,
    observedAt,
    orderFingerprint,
    manifestFingerprint,
    resourceFingerprint,
  ].every((value) => value !== null);

  if (decision === 'ALLOW') {
    if (
      !fullProvenance
      || reasons.length !== 1
      || reasons[0] !== 'admission_evidence_coherent'
    ) {
      throw new TypeError('ALLOW requiere provenance coherente y completo.');
    }
  } else if (decision === 'WAIT_CAPACITY') {
    if (
      !fullProvenance
      || reasons.length !== 1
      || reasons[0] !== 'capacity_unavailable'
    ) {
      throw new TypeError('WAIT_CAPACITY requiere evidencia válida de capacidad.');
    }
  } else if (
    reasons.includes('admission_evidence_coherent')
    || reasons.includes('capacity_unavailable')
  ) {
    throw new TypeError('BLOCKED no puede escalar evidencia coherente o de espera.');
  }

  return Object.freeze({
    ...core,
    reasons,
    fingerprint,
  }) as ExecutionAdmissionDecision;
}

export function admissionEvidence(decisionInput: unknown): AdmissionEvidence {
  const decision = parseDecision(decisionInput);
  const reasons = Object.freeze([...decision.reasons]);

  const core: AdmissionEvidenceCore = {
    version: 1,
    decision: decision.decision,
    authority: 'unchanged',
    runner_id: decision.runner_id,
    order_id: decision.order_id,
    work_item_id: decision.work_item_id,
    observed_at: decision.observed_at,
    reasons,
    order_fingerprint: decision.order_fingerprint,
    manifest_fingerprint: decision.manifest_fingerprint,
    resource_fingerprint: decision.resource_fingerprint,
    decision_fingerprint: decision.fingerprint,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
