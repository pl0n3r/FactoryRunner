import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  browserRemoteObservabilityPublicConsumerCompatibility,
  browserRemoteObservabilityPublicPacket,
  type BrowserRemoteDirectoryHealthBundle,
  type BrowserRemoteObservabilityPublicConsumer,
  type BrowserRemoteObservabilityPublicPacket,
  type BrowserRemoteObservabilityPublicRequirement,
} from '../src/index.ts';

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'))) {
      ordered[key] = canonicalValue(record[key]);
    }
    return ordered;
  }
  throw new TypeError('Valor no serializable.');
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex');
}

function healthBundle(): BrowserRemoteDirectoryHealthBundle {
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: 'READY' as const,
    doctor_fingerprint: 'a'.repeat(64),
    health_fingerprint: 'b'.repeat(64),
    metrics_fingerprint: 'c'.repeat(64),
    snapshot_fingerprint: 'd'.repeat(64),
    readiness_fingerprint: 'e'.repeat(64),
    network_access: false as const,
    external_mutation: false as const,
  });
  return Object.freeze({
    ...core,
    fingerprint: fingerprint(core),
  });
}

test('typed public observability consumer uses only the barrel contract', () => {
  const health = healthBundle();
  const packet: BrowserRemoteObservabilityPublicPacket =
    browserRemoteObservabilityPublicPacket(health);

  const requirement: BrowserRemoteObservabilityPublicRequirement = {
    export_name: 'browserRemoteDirectoryHealth',
    contract_version: 1,
  };
  const snapshotRequirement: BrowserRemoteObservabilityPublicRequirement = {
    export_name: 'browserRemoteDirectorySnapshot',
    contract_version: 1,
  };
  const consumer: BrowserRemoteObservabilityPublicConsumer = {
    version: 1,
    manifest_version: 1,
    required_exports: [requirement, snapshotRequirement],
  };

  const compatibility = browserRemoteObservabilityPublicConsumerCompatibility(
    packet,
    consumer,
  );

  assert.equal(packet.status, 'READY');
  assert.equal(packet.authority, 'unchanged');
  assert.equal(packet.network_access, false);
  assert.equal(packet.external_mutation, false);
  assert.equal(compatibility.status, 'COMPATIBLE');
  assert.equal(compatibility.authority, 'unchanged');
  assert.deepEqual(compatibility.reasons, []);
  assert.equal(compatibility.network_access, false);
  assert.equal(compatibility.external_mutation, false);
});
