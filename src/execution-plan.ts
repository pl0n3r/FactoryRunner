import type { CapabilityManifest } from './capability-manifest.ts';
import type { ExecutionAdmissionDecision } from './execution-admission.ts';
import {
  orderFingerprint,
  parseExecutionOrder,
  type ExecutionOrder,
} from './order.ts';
import {
  asRecord,
  capability,
  exactKeys,
  integer,
  ref,
  slug,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type ExecutionPlan = {
  version: 1;
  authority: 'unchanged';
  runner_id: string;
  order_id: string;
  work_item_id: string;
  capability: string;
  order_fingerprint: string;
  admission_fingerprint: string;
  adapter_id: string;
  manifest_fingerprint: string;
  resource_fingerprint: string;
  fingerprint: string;
};

type ExecutionPlanCore = Omit<ExecutionPlan, 'fingerprint'>;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ADMISSION_KEYS = [
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
const MANIFEST_KEYS = [
  'version',
  'runner_id',
  'protocol_version',
  'runtime',
  'runtime_version',
  'platform',
  'location',
  'max_parallel',
  'capabilities',
  'adapters',
  'fingerprint',
] as const;
const ADAPTER_KEYS = ['adapter_id', 'capabilities'] as const;

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
  return parsed;
}

function admittedDecision(
  input: unknown,
  order: ExecutionOrder,
): ExecutionAdmissionDecision {
  const record = asRecord(input, 'ExecutionAdmissionDecision');
  exactKeys(record, ADMISSION_KEYS, 'ExecutionAdmissionDecision');
  if (record.version !== 1) throw new TypeError('ExecutionAdmissionDecision version inválida.');
  if (record.decision !== 'ALLOW' || record.authority !== 'unchanged') {
    throw new TypeError('ExecutionAdmissionDecision no autoriza plan.');
  }

  const runnerId = uuid(record.runner_id, 'admission.runner_id');
  const orderId = uuid(record.order_id, 'admission.order_id');
  const workItemId = ref(record.work_item_id, 'admission.work_item_id', 160);
  integer(record.observed_at, 'admission.observed_at');
  const orderHash = sha256(record.order_fingerprint, 'admission.order_fingerprint');
  const manifestHash = sha256(record.manifest_fingerprint, 'admission.manifest_fingerprint');
  const resourceHash = sha256(record.resource_fingerprint, 'admission.resource_fingerprint');
  const fingerprint = sha256(record.fingerprint, 'admission.fingerprint');

  if (
    !Array.isArray(record.reasons)
    || record.reasons.length !== 1
    || record.reasons[0] !== 'admission_evidence_coherent'
  ) {
    throw new TypeError('ExecutionAdmissionDecision ALLOW no es canónica.');
  }
  ref(record.reasons[0], 'admission.reason', 64);

  const { fingerprint: _ignored, ...core } = record;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionAdmissionDecision fingerprint incoherente.');
  }
  if (
    runnerId !== order.runner_id
    || orderId !== order.order_id
    || workItemId !== order.work_item_id
    || orderHash !== orderFingerprint(order)
  ) {
    throw new TypeError('ExecutionAdmissionDecision no corresponde a la orden.');
  }

  return {
    ...(record as unknown as ExecutionAdmissionDecision),
    runner_id: runnerId,
    order_id: orderId,
    work_item_id: workItemId,
    order_fingerprint: orderHash,
    manifest_fingerprint: manifestHash,
    resource_fingerprint: resourceHash,
    fingerprint,
  };
}

function resolvedAdapter(
  input: unknown,
  order: ExecutionOrder,
  expectedFingerprint: string,
): { adapter_id: string; manifest_fingerprint: string } {
  const record = asRecord(input, 'CapabilityManifest');
  exactKeys(record, MANIFEST_KEYS, 'CapabilityManifest');
  if (record.version !== 1) throw new TypeError('CapabilityManifest version inválida.');
  if (uuid(record.runner_id, 'manifest.runner_id') !== order.runner_id) {
    throw new TypeError('CapabilityManifest pertenece a otro runner.');
  }

  const fingerprint = sha256(record.fingerprint, 'manifest.fingerprint');
  const { fingerprint: _ignored, ...core } = record;
  if (stableSha256(core) !== fingerprint || fingerprint !== expectedFingerprint) {
    throw new TypeError('CapabilityManifest fingerprint incoherente.');
  }

  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0 || record.capabilities.length > 256) {
    throw new TypeError('CapabilityManifest capabilities inválidas.');
  }
  const capabilities = record.capabilities.map((value) => capability(value, 'manifest.capability'));
  if (new Set(capabilities).size !== capabilities.length || !capabilities.includes(order.capability)) {
    throw new TypeError('CapabilityManifest no declara la capability de la orden.');
  }

  if (!Array.isArray(record.adapters) || record.adapters.length === 0 || record.adapters.length > 64) {
    throw new TypeError('CapabilityManifest adapters inválidos.');
  }

  const adapterIds = new Set<string>();
  const matches: string[] = [];
  for (const item of record.adapters) {
    const adapter = asRecord(item, 'manifest.adapter');
    exactKeys(adapter, ADAPTER_KEYS, 'manifest.adapter');
    const adapterId = slug(adapter.adapter_id, 'manifest.adapter_id');
    if (adapterIds.has(adapterId)) throw new TypeError('CapabilityManifest adapter duplicado.');
    adapterIds.add(adapterId);

    if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0 || adapter.capabilities.length > 128) {
      throw new TypeError('CapabilityManifest adapter capabilities inválidas.');
    }
    const adapterCapabilities = adapter.capabilities.map((value) =>
      capability(value, 'manifest.adapter.capability'),
    );
    if (new Set(adapterCapabilities).size !== adapterCapabilities.length) {
      throw new TypeError('CapabilityManifest adapter contiene capabilities duplicadas.');
    }
    if (adapterCapabilities.includes(order.capability)) matches.push(adapterId);
  }

  if (matches.length !== 1) {
    throw new TypeError('Adapter ausente o ambiguo para la capability admitida.');
  }
  return { adapter_id: matches[0], manifest_fingerprint: fingerprint };
}

export function executionPlan(
  orderInput: unknown,
  admissionInput: unknown,
  manifestInput: unknown,
): ExecutionPlan {
  const order = parseExecutionOrder(orderInput);
  const admission = admittedDecision(admissionInput, order);
  const adapter = resolvedAdapter(
    manifestInput as CapabilityManifest,
    order,
    admission.manifest_fingerprint as string,
  );

  const core: ExecutionPlanCore = {
    version: 1,
    authority: 'unchanged',
    runner_id: order.runner_id,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: admission.order_fingerprint as string,
    admission_fingerprint: admission.fingerprint,
    adapter_id: adapter.adapter_id,
    manifest_fingerprint: adapter.manifest_fingerprint,
    resource_fingerprint: admission.resource_fingerprint as string,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
