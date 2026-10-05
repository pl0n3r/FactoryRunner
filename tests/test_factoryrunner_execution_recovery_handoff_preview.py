"""Executable acceptance for read-only recovery handoff preview."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-preview.ts"


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
import { executionRecoveryHandoffPreview } from './src/execution-recovery-handoff-preview.ts';
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

function packet() {
  return executionRecoveryHandoffPacket(
    executionId,
    readiness(),
    snapshotFingerprint,
    planFingerprint,
  );
}
"""


class FactoryRunnerExecutionRecoveryHandoffPreviewTests(unittest.TestCase):
    def test_preview_exposes_only_verified_recovery_identity_fingerprints_and_no_execution_authority(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const input = packet();
            const first = executionRecoveryHandoffPreview(
              input,
              executionId,
              readiness(),
              snapshotFingerprint,
              planFingerprint,
            );
            const second = executionRecoveryHandoffPreview(
              input,
              executionId,
              readiness(),
              snapshotFingerprint,
              planFingerprint,
            );

            assert.deepEqual(first, second);
            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
            assert.equal(first.status, 'READY');
            assert.equal(first.verified, true);
            assert.equal(first.execution_id, executionId);
            assert.equal(first.handoff_fingerprint, input.fingerprint);
            assert.equal(first.readiness_fingerprint, input.readiness_fingerprint);
            assert.equal(first.snapshot_fingerprint, snapshotFingerprint);
            assert.equal(first.plan_fingerprint, planFingerprint);
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
              'handoff_fingerprint',
              'network_access',
              'plan_fingerprint',
              'readiness_fingerprint',
              'snapshot_fingerprint',
              'status',
              'verified',
              'version',
            ]);
            """
        )

    def test_missing_unverified_stale_or_mixed_handoff_blocks_without_effects(self) -> None:
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

            const valid = packet();
            const tampered = { ...valid, fingerprint: '0'.repeat(64) };
            const extra = { ...valid, unexpected: true };
            const authority = { ...valid, authority: 'elevated' };
            const effect = { ...valid, execution: true };

            const cases = [
              [undefined, executionId, readiness(), snapshotFingerprint, planFingerprint],
              [tampered, executionId, readiness(), snapshotFingerprint, planFingerprint],
              [extra, executionId, readiness(), snapshotFingerprint, planFingerprint],
              [authority, executionId, readiness(), snapshotFingerprint, planFingerprint],
              [effect, executionId, readiness(), snapshotFingerprint, planFingerprint],
              [valid, executionId, readiness(), 'c'.repeat(64), planFingerprint],
              [valid, executionId, readiness(), snapshotFingerprint, 'd'.repeat(64)],
            ];

            const stale = readiness();
            stale.fingerprint = 'e'.repeat(64);
            cases.push([valid, executionId, stale, snapshotFingerprint, planFingerprint]);

            for (const args of cases) {
              const preview = executionRecoveryHandoffPreview(...args);
              assert.deepEqual(preview, {
                version: 1,
                authority: 'unchanged',
                status: 'UNKNOWN',
                verified: false,
                reason: 'handoff_unverified',
                execution: false,
                network_access: false,
                external_mutation: false,
                fingerprint: preview.fingerprint,
              });
              assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
              assert.equal('execution_id' in preview, false);
              assert.equal('handoff_fingerprint' in preview, false);
              assert.equal('readiness_fingerprint' in preview, false);
              assert.equal('snapshot_fingerprint' in preview, false);
              assert.equal('plan_fingerprint' in preview, false);
            }
            """
        )


if __name__ == "__main__":
    unittest.main()
