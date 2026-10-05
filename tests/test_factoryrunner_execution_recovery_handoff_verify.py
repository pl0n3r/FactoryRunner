"""Executable acceptance for offline recovery handoff verification."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-verify.ts"


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


class FactoryRunnerExecutionRecoveryHandoffVerifyTests(unittest.TestCase):
    def test_verifier_accepts_only_exact_packet_and_bound_recovery_evidence(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const input = packet();
            const first = executionRecoveryHandoffVerify(
              input,
              executionId,
              readiness(),
              snapshotFingerprint,
              planFingerprint,
            );
            const second = executionRecoveryHandoffVerify(
              input,
              executionId,
              readiness(),
              snapshotFingerprint,
              planFingerprint,
            );

            assert.deepEqual(first, second);
            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
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
            """
        )

    def test_tampered_mixed_stale_or_unknown_packet_fails_closed_without_effects(self) -> None:
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
            const badFingerprint = { ...valid, fingerprint: '0'.repeat(64) };
            const unknownSchema = { ...valid, version: 2 };
            const extra = { ...valid, unexpected: true };
            const authority = { ...valid, authority: 'elevated' };
            const effect = { ...valid, execution: true };
            const tamperedExecution = { ...valid, execution_id: 'execution:other' };
            tamperedExecution.fingerprint = stableSha256({
              version: tamperedExecution.version,
              authority: tamperedExecution.authority,
              execution_id: tamperedExecution.execution_id,
              readiness_fingerprint: tamperedExecution.readiness_fingerprint,
              snapshot_fingerprint: tamperedExecution.snapshot_fingerprint,
              plan_fingerprint: tamperedExecution.plan_fingerprint,
              execution: tamperedExecution.execution,
              network_access: tamperedExecution.network_access,
              external_mutation: tamperedExecution.external_mutation,
            });

            for (const input of [
              badFingerprint,
              unknownSchema,
              extra,
              authority,
              effect,
              tamperedExecution,
            ]) {
              assert.throws(() => executionRecoveryHandoffVerify(
                input,
                executionId,
                readiness(),
                snapshotFingerprint,
                planFingerprint,
              ));
            }

            assert.throws(() => executionRecoveryHandoffVerify(
              valid,
              executionId,
              readiness(),
              'c'.repeat(64),
              planFingerprint,
            ));
            assert.throws(() => executionRecoveryHandoffVerify(
              valid,
              executionId,
              readiness(),
              snapshotFingerprint,
              'd'.repeat(64),
            ));

            const staleReadiness = readiness();
            staleReadiness.fingerprint = 'e'.repeat(64);
            assert.throws(() => executionRecoveryHandoffVerify(
              valid,
              executionId,
              staleReadiness,
              snapshotFingerprint,
              planFingerprint,
            ));
            """
        )


if __name__ == "__main__":
    unittest.main()
