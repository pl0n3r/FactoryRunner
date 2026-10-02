import {
  capabilityManifest,
  type CapabilityAdapterSource,
  type CapabilityManifest,
} from './capability-manifest.ts';
import {
  assertOrderExecutable,
  orderFingerprint,
  parseExecutionOrder,
} from './order.ts';
import { parseRunnerIdentity, type RunnerIdentity } from './runner.ts';
import {
  asRecord,
  capability,
  exactKeys,
  integer,
  slug,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type ExecutionAdmissionState = 'ALLOW' | 'WAIT_CAPACITY' | 'BLOCKED';

export type ExecutionAdmissionDecision = {
  version: 1;
  decision: ExecutionAdmissionState;
  authority: 'unchanged';
  runner_id: string | null;
  order_id: string | null;
  work_item_id: string | null;
  observed_at: number | null;
  order_fingerprint: string | null;
  manifest_fingerprint: string | null;
  resource_fingerprint: string | null;
  reasons: string[];
  fingerprint: string;
};

type DecisionCore = Omit<ExecutionAdmissionDecision, 'fingerprint'>;

type DecisionEvidence = Pick<
  DecisionCore,
  | 'runner_id'
  | 'order_id'
  | 'work_item_id'
  | 'observed_at'
  | 'order_fingerprint'
  | 'manifest_fingerprint'
  | 'resource_fingerprint'
>;

type AdmissionResourceSnapshot = {
  version: 1;
  runner_id: string;
  observed_at: number;
  heartbeat_sequence: number;
  runner_status: 'ready' | 'busy' | 'draining' | 'offline';
  max_parallel: number;
  active: number;
  available: number;
  queued_orders: number;
  dispatchable_orders: number;
  freshness: 'fresh';
  age_seconds: number;
  stale_after_seconds: number;
};

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

const MANIFEST_ADAPTER_KEYS = ['adapter_id', 'capabilities'] as const;

const RESOURCE_KEYS = [
  'version',
  'runner_id',
  'observed_at',
  'heartbeat_sequence',
  'runner_status',
  'max_parallel',
  'active',
  'available',
  'queued_orders',
  'dispatchable_orders',
  'freshness',
  'age_seconds',
  'stale_after_seconds',
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const DISPATCHABLE_STATUSES = new Set(['ready', 'busy']);
const RESOURCE_STATUSES = new Set(['ready', 'busy', 'draining', 'offline']);

function emptyEvidence(): DecisionEvidence {
  return {
    runner_id: null,
    order_id: null,
    work_item_id: null,
    observed_at: null,
    order_fingerprint: null,
    manifest_fingerprint: null,
    resource_fingerprint: null,
  };
}

function sha256(value: unknown, field: string): string {
  const parsed = stringValue(value, field, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(field + ' inválido.');
  return parsed;
}

function verdict(
  state: ExecutionAdmissionState,
  reasonsInput: readonly string[],
  evidence: DecisionEvidence,
): ExecutionAdmissionDecision {
  const reasons = Array.from(new Set(reasonsInput));
  reasons.sort((left, right) => left.localeCompare(right, 'en'));

  const core: DecisionCore = {
    version: 1,
    decision: state,
    authority: 'unchanged',
    ...evidence,
    reasons,
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}

function parseManifest(
  input: unknown,
  identity: RunnerIdentity,
): CapabilityManifest {
  const record = asRecord(input, 'CapabilityManifest');
  exactKeys(record, MANIFEST_KEYS, 'CapabilityManifest');
  if (record.version !== 1) throw new TypeError('CapabilityManifest version inválida.');
  if (!Array.isArray(record.adapters) || record.adapters.length === 0) {
    throw new TypeError('CapabilityManifest adapters inválidos.');
  }

  const adapters: CapabilityAdapterSource[] = record.adapters.map((item, index) => {
    const adapter = asRecord(item, 'manifest.adapters[' + index + ']');
    exactKeys(adapter, MANIFEST_ADAPTER_KEYS, 'manifest.adapters[' + index + ']');
    if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
      throw new TypeError('Manifest adapter sin capabilities.');
    }
    return {
      id: slug(adapter.adapter_id, 'manifest.adapter_id'),
      capabilities: adapter.capabilities.map((value) =>
        capability(value, 'manifest.capability'),
      ),
    };
  });

  const fingerprint = sha256(record.fingerprint, 'manifest.fingerprint');
  const { fingerprint: _ignored, ...core } = record;
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('CapabilityManifest fingerprint incoherente.');
  }

  const canonical = capabilityManifest(identity, adapters);
  if (canonical.fingerprint !== fingerprint) {
    throw new TypeError('Capability drift entre manifest e identity.');
  }
  return canonical;
}

function parseResource(
  input: unknown,
  identity: RunnerIdentity,
  now: number,
): AdmissionResourceSnapshot {
  const record = asRecord(input, 'ResourceSnapshot');
  exactKeys(record, RESOURCE_KEYS, 'ResourceSnapshot');
  if (record.version !== 1) throw new TypeError('ResourceSnapshot version inválida.');
  if (
    typeof record.runner_status !== 'string'
    || !RESOURCE_STATUSES.has(record.runner_status)
  ) {
    throw new TypeError('ResourceSnapshot status inválido.');
  }
  if (record.freshness !== 'fresh') {
    throw new TypeError('ResourceSnapshot no está fresh.');
  }

  const runnerId = uuid(record.runner_id, 'resource.runner_id');
  const observedAt = integer(record.observed_at, 'resource.observed_at');
  const heartbeatSequence = integer(
    record.heartbeat_sequence,
    'resource.heartbeat_sequence',
  );
  const maxParallel = integer(
    record.max_parallel,
    'resource.max_parallel',
    1,
    64,
  );
  const active = integer(record.active, 'resource.active', 0, maxParallel);
  const available = integer(
    record.available,
    'resource.available',
    0,
    maxParallel,
  );
  const queuedOrders = integer(record.queued_orders, 'resource.queued_orders');
  const dispatchableOrders = integer(
    record.dispatchable_orders,
    'resource.dispatchable_orders',
  );
  const ageSeconds = integer(record.age_seconds, 'resource.age_seconds');
  const staleAfterSeconds = integer(
    record.stale_after_seconds,
    'resource.stale_after_seconds',
    1,
    90,
  );

  if (runnerId !== identity.runner_id || maxParallel !== identity.max_parallel) {
    throw new TypeError('ResourceSnapshot drift de identity.');
  }
  if (observedAt > now || ageSeconds !== now - observedAt || ageSeconds > staleAfterSeconds) {
    throw new TypeError('ResourceSnapshot stale o temporalmente incoherente.');
  }

  const expectedAvailable = DISPATCHABLE_STATUSES.has(record.runner_status)
    ? maxParallel - active
    : 0;
  if (available !== expectedAvailable) {
    throw new TypeError('ResourceSnapshot capacidad incoherente.');
  }
  if (dispatchableOrders !== Math.min(available, queuedOrders)) {
    throw new TypeError('ResourceSnapshot dispatchable incoherente.');
  }

  return Object.freeze({
    version: 1,
    runner_id: runnerId,
    observed_at: observedAt,
    heartbeat_sequence: heartbeatSequence,
    runner_status: record.runner_status as AdmissionResourceSnapshot['runner_status'],
    max_parallel: maxParallel,
    active,
    available,
    queued_orders: queuedOrders,
    dispatchable_orders: dispatchableOrders,
    freshness: 'fresh',
    age_seconds: ageSeconds,
    stale_after_seconds: staleAfterSeconds,
  });
}

export function executionAdmissionDecision(
  identityInput: unknown,
  orderInput: unknown,
  manifestInput: unknown,
  resourceInput: unknown,
  nowInput: unknown,
): ExecutionAdmissionDecision {
  let evidence = emptyEvidence();

  try {
    const now = integer(nowInput, 'now');
    const identity = parseRunnerIdentity(identityInput);
    evidence = { ...evidence, runner_id: identity.runner_id };

    const order = parseExecutionOrder(orderInput);
    evidence = {
      ...evidence,
      order_id: order.order_id,
      work_item_id: order.work_item_id,
      order_fingerprint: orderFingerprint(order),
    };

    const manifest = parseManifest(manifestInput, identity);
    evidence = {
      ...evidence,
      manifest_fingerprint: manifest.fingerprint,
    };

    const resource = parseResource(resourceInput, identity, now);
    evidence = {
      ...evidence,
      observed_at: resource.observed_at,
      resource_fingerprint: stableSha256(resource),
    };

    assertOrderExecutable(order, identity, now);

    if (
      resource.runner_status === 'draining'
      || resource.runner_status === 'offline'
    ) {
      return verdict('BLOCKED', ['runner_not_dispatchable'], evidence);
    }

    if (resource.available === 0) {
      return verdict('WAIT_CAPACITY', ['capacity_unavailable'], evidence);
    }

    return verdict('ALLOW', ['admission_evidence_coherent'], evidence);
  } catch {
    return verdict('BLOCKED', ['admission_evidence_invalid'], evidence);
  }
}
