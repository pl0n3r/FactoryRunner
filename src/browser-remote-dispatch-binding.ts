import type { BrowserLoopRequest } from './browser-loop-request.ts';
import type { BrowserPlacementGuardEvidence } from './browser-placement-guard.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import { asRecord, exactKeys, stableSha256, stringValue } from './validation.ts';

export type BrowserRemoteDispatchBinding = Readonly<{
  version: 1;
  authority: 'unchanged';
  plan_fingerprint: string;
  request_fingerprint: string;
  placement_evidence_fingerprint: string;
  binding_fingerprint: string;
  fingerprint: string;
}>;

const PLAN_KEYS = [
  'version',
  'authority',
  'runner_id',
  'order_id',
  'work_item_id',
  'capability',
  'order_fingerprint',
  'admission_fingerprint',
  'adapter_id',
  'manifest_fingerprint',
  'resource_fingerprint',
  'fingerprint',
] as const;

const REQUEST_KEYS = [
  'version',
  'authority',
  'order_id',
  'runner_id',
  'work_item_id',
  'plan_fingerprint',
  'adapter_id',
  'capability',
  'browser_kind',
  'browser_fingerprint',
  'browser',
  'fingerprint',
] as const;

const PLACEMENT_EVIDENCE_KEYS = [
  'version',
  'authority',
  'order_fingerprint',
  'plan_fingerprint',
  'request_fingerprint',
  'placement_fingerprint',
  'binding_fingerprint',
  'fingerprint',
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(label + ' inválido.');
  return parsed;
}

function coherentFingerprint(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = asRecord(input, label);
  exactKeys(record, keys, label);
  const fingerprint = sha256(record.fingerprint, label + '.fingerprint');
  const { fingerprint: _ignored, ...core } = record;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError(label + ' fingerprint incoherente.');
  }
  return record;
}

export function browserRemoteDispatchBinding(
  planInput: ExecutionPlan,
  requestInput: BrowserLoopRequest,
  placementEvidenceInput: BrowserPlacementGuardEvidence,
): BrowserRemoteDispatchBinding {
  const plan = coherentFingerprint(planInput, PLAN_KEYS, 'ExecutionPlan');
  const request = coherentFingerprint(requestInput, REQUEST_KEYS, 'BrowserLoopRequest');
  const evidence = coherentFingerprint(
    placementEvidenceInput,
    PLACEMENT_EVIDENCE_KEYS,
    'BrowserPlacementGuardEvidence',
  );

  if (
    plan.version !== 1
    || plan.authority !== 'unchanged'
    || request.version !== 1
    || request.authority !== 'unchanged'
    || evidence.version !== 1
    || evidence.authority !== 'unchanged'
  ) {
    throw new TypeError('Binding browser remoto no conserva version/authority canónicas.');
  }

  const planFingerprint = sha256(plan.fingerprint, 'plan_fingerprint');
  const requestFingerprint = sha256(request.fingerprint, 'request_fingerprint');
  const placementEvidenceFingerprint = sha256(
    evidence.fingerprint,
    'placement_evidence_fingerprint',
  );
  const bindingFingerprint = sha256(
    evidence.binding_fingerprint,
    'binding_fingerprint',
  );

  if (
    request.plan_fingerprint !== planFingerprint
    || evidence.plan_fingerprint !== planFingerprint
    || evidence.request_fingerprint !== requestFingerprint
    || evidence.order_fingerprint !== plan.order_fingerprint
  ) {
    throw new TypeError('Plan, request y placement evidence no pertenecen al mismo binding.');
  }

  const core = {
    version: 1 as const,
    authority: 'unchanged' as const,
    plan_fingerprint: planFingerprint,
    request_fingerprint: requestFingerprint,
    placement_evidence_fingerprint: placementEvidenceFingerprint,
    binding_fingerprint: bindingFingerprint,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
