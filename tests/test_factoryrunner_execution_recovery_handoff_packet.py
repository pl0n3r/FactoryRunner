"""Executable acceptance for recovery handoff packet."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-packet.ts"


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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
"""


class FactoryRunnerExecutionRecoveryHandoffPacketTests(unittest.TestCase):
    def test_packet_binds_exact_recovery_readiness_snapshot_and_plan_deterministically(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const input = readiness();
            const first = executionRecoveryHandoffPacket(executionId, input);
            const second = executionRecoveryHandoffPacket(executionId, input);

            assert.deepEqual(first, second);
            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
            assert.equal(first.execution_id, executionId);
            assert.equal(first.readiness_fingerprint, input.fingerprint);
            assert.equal(first.snapshot_fingerprint, snapshotFingerprint);
            assert.equal(first.plan_fingerprint, planFingerprint);
            assert.equal(first.execution, false);
            assert.equal(first.network_access, false);
            assert.equal(first.external_mutation, false);
            assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

            const serialized = JSON.stringify(first);
            assert.equal(serialized.includes('work_item'), false);
            assert.equal(serialized.includes('delivery_id'), false);
            assert.equal(serialized.includes('event_id'), false);
            """
        )

    def test_stale_mixed_extra_or_authority_drift_fails_closed_without_effects(self) -> None:
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

            const stale = readiness();
            stale.fingerprint = '0'.repeat(64);

            const mixed = readiness({ snapshot_fingerprint: 'c'.repeat(64) });
            mixed.fingerprint = stableSha256({
              version: mixed.version,
              authority: mixed.authority,
              ready: mixed.ready,
              reason: mixed.reason,
              snapshot_fingerprint: mixed.snapshot_fingerprint,
              plan_fingerprint: mixed.plan_fingerprint,
              execution: mixed.execution,
              network_access: mixed.network_access,
              external_mutation: mixed.external_mutation,
              counts: mixed.counts,
            });

            const extra = { ...readiness(), unexpected: true };
            const authority = readiness({ authority: 'elevated' });
            const blocked = readiness({
              ready: false,
              reason: 'blocked',
              counts: { orders: 1, noop: 0, redeliver: 0, resume: 0, block: 1 },
            });
            const invalidCounts = readiness({
              counts: { orders: 4, noop: 1, redeliver: 1, resume: 1, block: 0 },
            });
            const badSnapshot = readiness({ snapshot_fingerprint: 'not-a-sha' });
            const badExecutionIds = ['', 'secret=abc', 'has space'];

            for (const input of [stale, extra, authority, blocked, invalidCounts, badSnapshot]) {
              assert.throws(() => executionRecoveryHandoffPacket(executionId, input));
            }
            for (const id of badExecutionIds) {
              assert.throws(() => executionRecoveryHandoffPacket(id, readiness()));
            }

            const mixedPacket = executionRecoveryHandoffPacket(executionId, mixed);
            assert.equal(mixedPacket.snapshot_fingerprint, 'c'.repeat(64));
            assert.equal(mixedPacket.execution, false);
            assert.equal(mixedPacket.network_access, false);
            assert.equal(mixedPacket.external_mutation, false);
            """
        )


if __name__ == "__main__":
    unittest.main()
