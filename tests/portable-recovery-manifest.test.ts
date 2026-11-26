import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { portableRecoveryManifest } from '../src/portable-recovery-manifest.ts';
import { executionRecoveryPlan } from '../src/execution-recovery-plan.ts';
import { executionRecoveryReadiness } from '../src/execution-recovery-readiness.ts';
import { executionRecoveryHandoffPacket } from '../src/execution-recovery-handoff-packet.ts';
import { stableSha256 } from '../src/validation.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const LEASE_A = '44444444-4444-4444-8444-444444444444';
const LEASE_B = '55555555-5555-4555-8555-555555555555';
const NOW = 1_800_000_100;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const FENCE = stableSha256('synthetic-fence-proof-v1');
function seal<T extends object>(core: T) { return { ...core, fingerprint: stableSha256(core) }; }

function fixture() {
  const execution = seal({
    version: 1, order_id: ORDER, runner_id: A, work_item_id: 'synthetic:work',
    order_fingerprint: 'a'.repeat(64), plan_fingerprint: null, recovery: 'pending',
    last_event_id: null, last_sequence: 0,
    counts: { events: 0, pending_deliveries: 0, delivered_deliveries: 0 }, deliveries: [],
  });
  const snapshot = seal({
    version: 1, counts: { orders: 1, events: 0, pending_deliveries: 0, delivered_deliveries: 0 },
    executions: [execution],
  });
  const plan = executionRecoveryPlan(snapshot);
  const readiness = executionRecoveryReadiness(snapshot, plan);
  assert.equal(readiness.ready, true);
  const handoff = executionRecoveryHandoffPacket(ORDER, readiness, snapshot.fingerprint, plan.fingerprint);

  // Public deterministic TEST-ONLY AES fixture; never use for real data.
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 3);
  const clear = Buffer.from(JSON.stringify({ kind: 'SYNTHETIC_ONLY', snapshot: snapshot.fingerprint }));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const artifact = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  const decipher = createDecipheriv('aes-256-gcm', key, artifact.subarray(0, 12));
  decipher.setAuthTag(artifact.subarray(12, 28));
  assert.deepEqual(Buffer.concat([decipher.update(artifact.subarray(28)), decipher.final()]), clear);
  const manifest = seal({
    schema_version: 1, origin: 'SYNTHETIC_OFFLINE', release_version: '1.0.0',
    release_sha: 'b'.repeat(40), created_at: NOW - 100, expires_at: NOW + 100,
    source_runner_id: A, order_id: ORDER, source_lease_id: LEASE_A, source_generation: 1,
    artifact_sha256: hash(artifact), handoff_fingerprint: handoff.fingerprint,
  });
  const durable = {
    origin: 'SYNTHETIC_CONTROL_PLANE', authority: 'VERIFIED', observed_at: NOW,
    manifest_pin: manifest.fingerprint, release_version: manifest.release_version,
    release_sha: manifest.release_sha, order_id: ORDER, source_runner_id: A,
    source_lease_id: LEASE_A, source_generation: 1, source_revoked: true,
    active_runner_ids: [B], target_lease_id: LEASE_B, target_generation: 2,
    target_expires_at: NOW + 100, fence_fingerprint: FENCE, prior_receipt: null,
  };
  return { manifest, durable, artifact, snapshot, handoff };
}
function verify(f = fixture(), changes: {
  manifest?: unknown; durable?: unknown; artifact?: Uint8Array; snapshot?: unknown;
  handoff?: unknown; runner?: unknown; proof?: unknown; now?: unknown;
} = {}) {
  return portableRecoveryManifest(
    changes.manifest ?? f.manifest, changes.durable ?? f.durable,
    changes.artifact ?? f.artifact, changes.snapshot ?? f.snapshot, changes.handoff ?? f.handoff,
    changes.runner ?? B, changes.proof === undefined ? FENCE : changes.proof, changes.now ?? NOW,
  );
}
test('AC01/02: B restores evidence only; independent durable receipt prevents replay', () => {
  const f = fixture();
  const first = verify(f);
  assert.equal(first.status, 'VERIFIED_OFFLINE');
  assert.equal(first.runner_id, B);
  assert.equal(first.generation, 2);
  assert.equal(first.execution, false);
  assert.equal(first.network_access, false);
  assert.equal(first.external_mutation, false);
  // Independent copy of durable state, not a cache or shared runner disk.
  const durable = JSON.parse(JSON.stringify({ ...f.durable, prior_receipt: first.receipt }));
  const retry = verify(fixture(), { durable });
  assert.equal(retry.status, 'ALREADY_VERIFIED_OFFLINE');
  assert.equal(retry.receipt, first.receipt);
  assert.throws(() => verify(f, { durable: { ...durable, prior_receipt: '0'.repeat(64) } }));
});
test('AC01: corrupt artifact, substituted pin, stale, source and schema drift fail closed', () => {
  const f = fixture();
  const corrupted = Buffer.from(f.artifact);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => verify(f, { artifact: corrupted }));
  assert.throws(() => verify(f, { artifact: Buffer.alloc(65_537) }));
  for (const changes of [
    { schema_version: 2 }, { origin: 'UNKNOWN' }, { release_sha: '0'.repeat(40) },
    { release_version: '2.0.0' }, { expires_at: NOW }, { handoff_fingerprint: '0'.repeat(64) },
  ]) {
    const { fingerprint: _pin, ...core } = f.manifest;
    const modified = seal({ ...core, ...changes });
    assert.throws(() => verify(f, { manifest: modified }));
    assert.throws(() => verify(f, { manifest: modified, durable: { ...f.durable, manifest_pin: modified.fingerprint } }));
  }
  assert.throws(() => verify(f, { now: NOW + 100 }));
  assert.throws(() => verify(f, { snapshot: { ...f.snapshot, fingerprint: '0'.repeat(64) } }));
  assert.throws(() => verify(f, { handoff: { ...f.handoff, fingerprint: '0'.repeat(64) } }));
});
test('AC02: cloned A, split brain, expired lease, unknown authority and missing fence denied', () => {
  const f = fixture();
  assert.throws(() => verify(f, { runner: A }));
  for (const changes of [
    { active_runner_ids: [A, B] }, { active_runner_ids: [B, B] }, { active_runner_ids: [] },
    { source_revoked: false }, { authority: 'UNKNOWN' }, { origin: 'UNKNOWN' },
    { target_generation: 1 }, { target_expires_at: NOW }, { target_lease_id: LEASE_A },
    { observed_at: NOW + 1 }, { order_id: LEASE_A }, { fence_fingerprint: null },
  ]) assert.throws(() => verify(f, { durable: { ...f.durable, ...changes } }));
  assert.throws(() => verify(f, { proof: null }));
  assert.throws(() => verify(f, { proof: '0'.repeat(64) }));
});
test('AC03: extra fields and synthetic sensitive sentinel never enter result or error', () => {
  const f = fixture();
  const sentinel = 'SYNTHETIC_PRIVATE_VALUE';
  for (const changes of [
    { manifest: { ...f.manifest, password: sentinel } },
    { durable: { ...f.durable, cookie: sentinel } },
    { runner: sentinel }, { proof: sentinel },
  ]) assert.throws(() => verify(f, changes), (error: unknown) =>
    error instanceof Error && !error.message.includes(sentinel));
  assert.doesNotMatch(JSON.stringify(verify(f)), /password|cookie|secret|PRIVATE_VALUE|VALIDATED_IN_PRODUCTION/);
});
