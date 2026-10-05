"""Executable acceptance for canonical recovery handoff manifest."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-manifest.ts"


def run_node(source: str) -> None:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            textwrap.dedent(source),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)


NODE_FIXTURE = r"""
import assert from 'node:assert/strict';
import { executionRecoveryHandoffPacket } from './src/execution-recovery-handoff-packet.ts';
import { executionRecoveryHandoffVerify } from './src/execution-recovery-handoff-verify.ts';
import { executionRecoveryHandoffPreview } from './src/execution-recovery-handoff-preview.ts';
import { executionRecoveryHandoffManifest } from './src/execution-recovery-handoff-manifest.ts';
import { stableSha256 } from './src/validation.ts';

const executionId = 'execution:recovery:handoff:alpha';
const snapshotFingerprint = 'a'.repeat(64);
const planFingerprint = 'b'.repeat(64);

function readiness(overrides = {}) {
  const core = {
    version: 1,
    authority: 'unchanged',
    ready: true,
    reason: 'ready',
    snapshot_fingerprint: snapshotFingerprint,
    plan_fingerprint: planFingerprint,
    execution: false,
    network_access: false,
    external_mutation: false,
    counts: {
      orders: 3,
      noop: 1,
      redeliver: 1,
      resume: 1,
      block: 0,
    },
    ...overrides,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function evidence() {
  const ready = readiness();
  const packet = executionRecoveryHandoffPacket(
    executionId,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  const verification = executionRecoveryHandoffVerify(
    packet,
    executionId,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  const preview = executionRecoveryHandoffPreview(
    packet,
    executionId,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  return { ready, packet, verification, preview };
}

function manifest(packet, verification, preview, ready = readiness()) {
  return executionRecoveryHandoffManifest(
    packet,
    verification,
    preview,
    executionId,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
}
"""


class FactoryRunnerExecutionRecoveryHandoffManifestTests(unittest.TestCase):
    def test_manifest_binds_exact_packet_verification_and_preview_fingerprints_deterministically(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const { packet, verification, preview } = evidence();
            const first = manifest(packet, verification, preview);
            const second = manifest(packet, verification, preview);

            assert.deepEqual(first, second);
            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
            assert.equal(first.execution_id, executionId);
            assert.equal(first.packet_fingerprint, packet.fingerprint);
            assert.equal(first.verification_fingerprint, verification.fingerprint);
            assert.equal(first.preview_fingerprint, preview.fingerprint);
            assert.equal(first.execution, false);
            assert.equal(first.network_access, false);
            assert.equal(first.external_mutation, false);
            assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

            assert.deepEqual(Object.keys(first).sort(), [
              'authority',
              'execution',
              'execution_id',
              'external_mutation',
              'fingerprint',
              'network_access',
              'packet_fingerprint',
              'preview_fingerprint',
              'verification_fingerprint',
              'version',
            ]);

            const serialized = JSON.stringify(first);
            for (const forbidden of [
              'readiness_fingerprint',
              'snapshot_fingerprint',
              'plan_fingerprint',
              'counts',
              'orders',
              'events',
              'payload',
              'secret',
            ]) {
              assert.equal(serialized.includes(forbidden), false);
            }
            """
        )

    def test_mixed_stale_extra_or_authority_drift_fails_closed_without_payloads_or_effects(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
            "fetch(",
            "exec(",
            "spawn(",
            "writeFile",
            "appendFile",
            "ControlBotClient",
            "BrowserExecutionAdapter",
        ):
            self.assertNotIn(forbidden, source)

        run_node(
            NODE_FIXTURE
            + r"""
            globalThis.fetch = () => { throw new Error('network access attempted'); };

            const { packet, verification, preview } = evidence();

            const badPacketFingerprint = { ...packet, fingerprint: '0'.repeat(64) };
            const extraPacket = { ...packet, payload: { secret: 'nope' } };
            const authorityPacket = { ...packet, authority: 'elevated' };
            const effectPacket = { ...packet, execution: true };

            const badVerification = { ...verification, fingerprint: '1'.repeat(64) };
            const extraVerification = { ...verification, unexpected: true };

            const badPreview = { ...preview, fingerprint: '2'.repeat(64) };
            const extraPreview = { ...preview, unexpected: true };

            for (const [candidatePacket, candidateVerification, candidatePreview] of [
              [badPacketFingerprint, verification, preview],
              [extraPacket, verification, preview],
              [authorityPacket, verification, preview],
              [effectPacket, verification, preview],
              [packet, badVerification, preview],
              [packet, extraVerification, preview],
              [packet, verification, badPreview],
              [packet, verification, extraPreview],
            ]) {
              assert.throws(() => manifest(candidatePacket, candidateVerification, candidatePreview));
            }

            const otherExecution = 'execution:recovery:handoff:beta';
            const ready = readiness();
            const otherPacket = executionRecoveryHandoffPacket(
              otherExecution,
              ready,
              snapshotFingerprint,
              planFingerprint,
            );
            const otherVerification = executionRecoveryHandoffVerify(
              otherPacket,
              otherExecution,
              ready,
              snapshotFingerprint,
              planFingerprint,
            );
            const otherPreview = executionRecoveryHandoffPreview(
              otherPacket,
              otherExecution,
              ready,
              snapshotFingerprint,
              planFingerprint,
            );

            assert.throws(() => manifest(packet, otherVerification, preview));
            assert.throws(() => manifest(packet, verification, otherPreview));

            const stale = readiness();
            stale.fingerprint = 'e'.repeat(64);
            assert.throws(() => manifest(packet, verification, preview, stale));

            assert.throws(() => executionRecoveryHandoffManifest(
              packet,
              verification,
              preview,
              executionId,
              readiness(),
              'c'.repeat(64),
              planFingerprint,
            ));
            """
        )


if __name__ == "__main__":
    unittest.main()
