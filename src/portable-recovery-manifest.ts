import { createHash } from 'node:crypto';
import { executionRecoveryPlan } from './execution-recovery-plan.ts';
import { executionRecoveryReadiness } from './execution-recovery-readiness.ts';
import { executionRecoveryHandoffVerify } from './execution-recovery-handoff-verify.ts';
import { asRecord, exactKeys, integer, semver, stableSha256, uuid } from './validation.ts';

const MAX_TTL = 86_400;
const SAFETY = Object.freeze({
  scope: 'SYNTHETIC_OFFLINE' as const, authority: 'unchanged' as const,
  execution: false as const, network_access: false as const, external_mutation: false as const,
});
function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Synthetic recovery evidence rejected.');
}
function closed(input: unknown, fields: readonly string[]) {
  const value = asRecord(input, 'synthetic recovery');
  const proto = Object.getPrototypeOf(value);
  requireCondition(proto === Object.prototype || proto === null);
  exactKeys(value, fields, 'synthetic recovery');
  requireCondition(fields.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')));
  return value;
}
function digest(input: unknown, length = 64): string {
  requireCondition(typeof input === 'string' && input.length === length && !/[^a-f0-9]/.test(input));
  return input;
}

/** Pure rehearsal. Neither the backup nor a local cache grants authority. */
export function portableRecoveryManifest(
  manifestInput: unknown, durableInput: unknown, artifact: Uint8Array,
  snapshot: unknown, handoff: unknown, targetRunner: unknown, fenceProof: unknown, nowInput: unknown,
) {
  const now = integer(nowInput, 'now', 1);
  const manifest = closed(manifestInput, [
    'schema_version', 'origin', 'release_version', 'release_sha', 'created_at', 'expires_at',
    'source_runner_id', 'order_id', 'source_lease_id', 'source_generation',
    'artifact_sha256', 'handoff_fingerprint', 'fingerprint',
  ]);
  const created = integer(manifest.created_at, 'created_at', 1);
  const expires = integer(manifest.expires_at, 'expires_at', created + 1);
  requireCondition(manifest.schema_version === 1 && manifest.origin === 'SYNTHETIC_OFFLINE');
  requireCondition(created <= now && now < expires && expires - created <= MAX_TTL);
  const core = Object.freeze({
    schema_version: 1, origin: 'SYNTHETIC_OFFLINE',
    release_version: semver(manifest.release_version, 'release_version'),
    release_sha: digest(manifest.release_sha, 40), created_at: created, expires_at: expires,
    source_runner_id: uuid(manifest.source_runner_id, 'source_runner_id'),
    order_id: uuid(manifest.order_id, 'order_id'),
    source_lease_id: uuid(manifest.source_lease_id, 'source_lease_id'),
    source_generation: integer(manifest.source_generation, 'source_generation', 1),
    artifact_sha256: digest(manifest.artifact_sha256),
    handoff_fingerprint: digest(manifest.handoff_fingerprint),
  });
  const pin = digest(manifest.fingerprint);
  requireCondition(stableSha256(core) === pin);
  requireCondition(artifact instanceof Uint8Array && artifact.byteLength >= 28 && artifact.byteLength <= 65_536);
  requireCondition(createHash('sha256').update(artifact).digest('hex') === core.artifact_sha256);

  const durable = closed(durableInput, [
    'origin', 'authority', 'observed_at', 'manifest_pin', 'release_version', 'release_sha',
    'order_id', 'source_runner_id', 'source_lease_id', 'source_generation', 'source_revoked',
    'active_runner_ids', 'target_lease_id', 'target_generation', 'target_expires_at',
    'fence_fingerprint', 'prior_receipt',
  ]);
  const observed = integer(durable.observed_at, 'observed_at', created);
  requireCondition(durable.origin === 'SYNTHETIC_CONTROL_PLANE' && durable.authority === 'VERIFIED');
  requireCondition(observed <= now && now - observed <= 300);
  requireCondition(durable.manifest_pin === pin && durable.release_version === core.release_version
    && durable.release_sha === core.release_sha && durable.order_id === core.order_id
    && durable.source_runner_id === core.source_runner_id && durable.source_lease_id === core.source_lease_id
    && durable.source_generation === core.source_generation && durable.source_revoked === true);
  const runner = uuid(targetRunner, 'target_runner_id');
  requireCondition(runner !== core.source_runner_id);
  requireCondition(Array.isArray(durable.active_runner_ids) && durable.active_runner_ids.length === 1
    && durable.active_runner_ids[0] === runner);
  const lease = uuid(durable.target_lease_id, 'target_lease_id');
  const generation = integer(durable.target_generation, 'target_generation', 1);
  const targetExpires = integer(durable.target_expires_at, 'target_expires_at', 1);
  requireCondition(lease !== core.source_lease_id && generation > core.source_generation
    && now < targetExpires && targetExpires - observed <= MAX_TTL);
  requireCondition(digest(fenceProof) === digest(durable.fence_fingerprint));

  // Canonical recovery plan, readiness and handoff remain evidence, not permission.
  const plan = executionRecoveryPlan(snapshot);
  const readiness = executionRecoveryReadiness(snapshot, plan);
  const item = plan.items.find(candidate => candidate.order_id === core.order_id);
  requireCondition(readiness.ready && item !== undefined
    && item.runner_id === core.source_runner_id && item.action !== 'block');
  const verified = executionRecoveryHandoffVerify(
    handoff, core.order_id, readiness, plan.snapshot_fingerprint, plan.fingerprint,
  );
  requireCondition(verified.handoff_fingerprint === core.handoff_fingerprint);
  const receipt = stableSha256({
    manifest_pin: pin, order_id: core.order_id, runner_id: runner, lease_id: lease,
    generation, fence_fingerprint: digest(fenceProof), handoff_fingerprint: verified.handoff_fingerprint,
  });
  requireCondition(durable.prior_receipt === null || digest(durable.prior_receipt) === receipt);
  return Object.freeze({
    ...SAFETY, status: durable.prior_receipt === null ? 'VERIFIED_OFFLINE' : 'ALREADY_VERIFIED_OFFLINE',
    receipt, runner_id: runner, generation,
  });
}
