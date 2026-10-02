import { Buffer } from 'node:buffer';

import { capabilityManifest } from './capability-manifest.ts';
import type { CapabilityAdapterSource } from './capability-manifest.ts';
import { assertOrderExecutable, orderFingerprint, parseExecutionOrder } from './order.ts';
import type { ExecutionOrder } from './order.ts';
import { resourceSnapshot } from './resource-snapshot.ts';
import { parseRunnerIdentity } from './runner.ts';
import type { RunnerIdentity } from './runner.ts';
import {
  asRecord,
  integer,
  noSensitiveText,
  slug,
  stableSha256,
  stringValue,
} from './validation.ts';

export type TelemetryMetricValue = string | number | boolean;
export type TelemetryMetrics = Record<string, TelemetryMetricValue>;

export type TelemetryEnvelope = {
  version: 1;
  runner_id: string;
  order_id: string;
  work_item_id: string;
  capability: string;
  observed_at: number;
  instruction_ref: string;
  manifest_fingerprint: string;
  order_fingerprint: string;
  resource_fingerprint: string;
  metrics: TelemetryMetrics;
  authority: 'unchanged';
  execute_actions: false;
  fingerprint: string;
};

type TelemetryCore = Omit<TelemetryEnvelope, 'fingerprint'>;

const MAX_METRICS = 16;
const MAX_METRIC_TEXT = 160;
const MAX_METRICS_BYTES = 2_048;
const MAX_ABS_NUMBER = 1_000_000_000_000;
const SENSITIVE_METRIC_SEGMENTS = new Set([
  'password',
  'passwd',
  'token',
  'secret',
  'cookie',
  'authorization',
  'dsn',
]);

function assertSafeMetricKey(key: string): void {
  const segments = key.split(/[.-]/);
  const compact = segments.join('');
  if (
    segments.some((segment) => SENSITIVE_METRIC_SEGMENTS.has(segment))
    || compact === 'privatekey'
    || compact === 'apikey'
  ) {
    throw new TypeError('telemetry.metric contiene nombre sensible.');
  }
}

function telemetryMetrics(input: unknown): TelemetryMetrics {
  const record = asRecord(input, 'telemetry.metrics');
  const entries = Object.entries(record);
  if (entries.length > MAX_METRICS) {
    throw new TypeError('telemetry.metrics excede el límite.');
  }

  const output: TelemetryMetrics = {};
  for (const [rawKey, rawValue] of entries) {
    const key = slug(rawKey, 'telemetry.metric');
    assertSafeMetricKey(key);
    if (typeof rawValue === 'string') {
      output[key] = noSensitiveText(
        stringValue(rawValue, `telemetry.metrics.${key}`, MAX_METRIC_TEXT),
        `telemetry.metrics.${key}`,
      );
      continue;
    }
    if (typeof rawValue === 'boolean') {
      output[key] = rawValue;
      continue;
    }
    if (
      typeof rawValue === 'number'
      && Number.isFinite(rawValue)
      && Math.abs(rawValue) <= MAX_ABS_NUMBER
    ) {
      output[key] = rawValue;
      continue;
    }
    throw new TypeError(`telemetry.metrics.${key} inválido.`);
  }

  const ordered: TelemetryMetrics = {};
  for (const key of Object.keys(output).sort((a, b) => a.localeCompare(b, 'en'))) {
    ordered[key] = output[key] as TelemetryMetricValue;
  }

  if (Buffer.byteLength(JSON.stringify(ordered), 'utf8') > MAX_METRICS_BYTES) {
    throw new TypeError('telemetry.metrics excede el tamaño permitido.');
  }
  return ordered;
}

function assertOrderLinksRunner(
  order: ExecutionOrder,
  identity: RunnerIdentity,
): void {
  if (order.runner_id !== identity.runner_id) {
    throw new TypeError('Telemetry order pertenece a otro runner.');
  }
  if (!identity.capabilities.includes(order.capability)) {
    throw new TypeError('Telemetry order usa capability no declarada.');
  }
}

export function telemetryEnvelope(
  identityInput: unknown,
  adaptersInput: readonly CapabilityAdapterSource[],
  orderInput: unknown,
  heartbeatInput: unknown,
  queueInput: unknown,
  nowInput: unknown,
  staleAfterSecondsInput: unknown,
  metricsInput: unknown,
): TelemetryEnvelope {
  const identity = parseRunnerIdentity(identityInput);
  const order = parseExecutionOrder(orderInput);
  const now = integer(nowInput, 'now');
  assertOrderLinksRunner(order, identity);
  assertOrderExecutable(order, identity, now);

  const manifest = capabilityManifest(identity, adaptersInput);
  const resources = resourceSnapshot(
    identity,
    heartbeatInput,
    queueInput,
    now,
    staleAfterSecondsInput,
  );
  if (resources.runner_id !== identity.runner_id) {
    throw new TypeError('ResourceSnapshot pertenece a otro runner.');
  }

  const metrics = telemetryMetrics(metricsInput);
  const core: TelemetryCore = {
    version: 1,
    runner_id: identity.runner_id,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    capability: order.capability,
    observed_at: resources.observed_at,
    instruction_ref: order.instruction_ref,
    manifest_fingerprint: manifest.fingerprint,
    order_fingerprint: orderFingerprint(order),
    resource_fingerprint: stableSha256(resources),
    metrics,
    authority: 'unchanged',
    execute_actions: false,
  };

  return {
    ...core,
    fingerprint: stableSha256(core),
  };
}
