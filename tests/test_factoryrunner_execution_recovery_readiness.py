"""Executable acceptance for local recovery readiness."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-readiness.ts"


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
import { executionRecoveryReadiness } from './src/execution-recovery-readiness.ts';
import { executionRecoveryPlan } from './src/execution-recovery-plan.ts';
import { stableSha256 } from './src/validation.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const eventId = (suffix) => `33333333-3333-7333-8333-${suffix}`;
const orderId = (suffix) => `22222222-2222-7222-8222-${suffix}`;

function delivery(kind, state, marker, terminalEventId = null) {
  return Object.freeze({
    delivery_id: `outbox:${kind}:${marker.repeat(64)}`,
    kind,
    state,
    fingerprint: marker.repeat(64),
    plan_fingerprint: null,
    event_ids: terminalEventId === null ? Object.freeze([]) : Object.freeze([terminalEventId]),
  });
}

function recoveredExecution({ suffix, recovery, deliveries, events }) {
  const lastEventId = events === 0 ? null : eventId(suffix);
  const counts = Object.freeze({
    events,
    pending_deliveries: deliveries.filter((item) => item.state === 'pending').length,
    delivered_deliveries: deliveries.filter((item) => item.state === 'delivered').length,
  });
  const core = Object.freeze({
    version: 1,
    order_id: orderId(suffix),
    runner_id: runnerId,
    work_item_id: `work:recovery:${suffix}`,
    order_fingerprint: '9'.repeat(64),
    plan_fingerprint: null,
    recovery,
    last_event_id: lastEventId,
    last_sequence: events,
    counts,
    deliveries: Object.freeze([...deliveries].sort((a, b) => a.delivery_id.localeCompare(b.delivery_id, 'en'))),
  });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

function snapshotOf(executions) {
  const ordered = Object.freeze([...executions].sort((a, b) => a.order_id.localeCompare(b.order_id, 'en')));
  const counts = Object.freeze({
    orders: ordered.length,
    events: ordered.reduce((sum, item) => sum + item.counts.events, 0),
    pending_deliveries: ordered.reduce((sum, item) => sum + item.counts.pending_deliveries, 0),
    delivered_deliveries: ordered.reduce((sum, item) => sum + item.counts.delivered_deliveries, 0),
  });
  const core = Object.freeze({ version: 1, counts, executions: ordered });
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

const noopTerminal = recoveredExecution({
  suffix: '222222222221',
  recovery: 'terminal',
  events: 3,
  deliveries: [
    delivery('ack', 'delivered', 'a'),
    delivery('events', 'delivered', 'b', eventId('222222222221')),
  ],
});
const redeliverTerminal = recoveredExecution({
  suffix: '222222222222',
  recovery: 'terminal',
  events: 3,
  deliveries: [
    delivery('ack', 'delivered', 'c'),
    delivery('events', 'pending', 'd', eventId('222222222222')),
  ],
});
const resumeInterrupted = recoveredExecution({
  suffix: '222222222223',
  recovery: 'interrupted',
  events: 2,
  deliveries: [delivery('ack', 'delivered', 'e')],
});
const blockedTerminal = recoveredExecution({
  suffix: '222222222224',
  recovery: 'terminal',
  events: 3,
  deliveries: [delivery('ack', 'delivered', 'f')],
});

const readySnapshot = snapshotOf([redeliverTerminal, noopTerminal, resumeInterrupted]);
const readyPlan = executionRecoveryPlan(readySnapshot);
const blockedSnapshot = snapshotOf([blockedTerminal, noopTerminal]);
const blockedPlan = executionRecoveryPlan(blockedSnapshot);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function refingerprintPlan(plan) {
  const next = clone(plan);
  next.items = next.items.map((item) => {
    const { fingerprint, ...core } = item;
    return { ...core, fingerprint: stableSha256(core) };
  });
  const { fingerprint, ...core } = next;
  return { ...core, fingerprint: stableSha256(core) };
}
"""


class FactoryRunnerExecutionRecoveryReadinessTests(unittest.TestCase):
    def test_readiness_binds_snapshot_and_plan_fingerprints_and_exposes_bounded_counts(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const first = executionRecoveryReadiness(readySnapshot, readyPlan);
            const second = executionRecoveryReadiness(readySnapshot, readyPlan);

            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
            assert.equal(first.ready, true);
            assert.equal(first.reason, 'ready');
            assert.equal(first.snapshot_fingerprint, readySnapshot.fingerprint);
            assert.equal(first.plan_fingerprint, readyPlan.fingerprint);
            assert.deepEqual(first.counts, {
              orders: 3,
              noop: 1,
              redeliver: 1,
              resume: 1,
              block: 0,
            });
            assert.equal(first.execution, false);
            assert.equal(first.network_access, false);
            assert.equal(first.external_mutation, false);
            assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
            assert.equal(first.fingerprint, second.fingerprint);
            assert.deepEqual(first, second);

            const serialized = JSON.stringify(first);
            assert.equal(serialized.includes('work:recovery'), false);
            assert.equal(serialized.includes('delivery_id'), false);
            assert.equal(serialized.includes('last_event'), false);
            """
        )

    def test_stale_mixed_or_blocked_recovery_remains_not_ready_without_external_effects(self) -> None:
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

            const staleSnapshot = clone(readySnapshot);
            staleSnapshot.fingerprint = '0'.repeat(64);

            const wrongSnapshotBinding = refingerprintPlan({
              ...clone(readyPlan),
              snapshot_fingerprint: '1'.repeat(64),
            });

            const tamperedPlanFingerprint = clone(readyPlan);
            tamperedPlanFingerprint.fingerprint = '2'.repeat(64);

            const mismatchedItem = clone(readyPlan);
            mismatchedItem.items[0].snapshot_execution_fingerprint = '3'.repeat(64);
            const mismatchedItemPlan = refingerprintPlan(mismatchedItem);

            const missingItem = clone(readyPlan);
            missingItem.items.pop();
            missingItem.counts.resume -= 1;
            const missingPlan = refingerprintPlan(missingItem);

            const extraItem = clone(readyPlan);
            extraItem.items.push(clone(extraItem.items[0]));
            extraItem.items[3].order_id = orderId('222222222229');
            extraItem.items[3].fingerprint = stableSha256((({ fingerprint, ...core }) => core)(extraItem.items[3]));
            extraItem.counts[extraItem.items[3].action] += 1;
            const extraPlan = refingerprintPlan(extraItem);

            const duplicateItem = clone(readyPlan);
            duplicateItem.items[1] = clone(duplicateItem.items[0]);
            duplicateItem.counts = {
              noop: duplicateItem.items.filter((item) => item.action === 'noop').length,
              redeliver: duplicateItem.items.filter((item) => item.action === 'redeliver').length,
              resume: duplicateItem.items.filter((item) => item.action === 'resume').length,
              block: duplicateItem.items.filter((item) => item.action === 'block').length,
            };
            const duplicatePlan = refingerprintPlan(duplicateItem);

            const wrongCounts = clone(readyPlan);
            wrongCounts.counts.noop += 1;
            const wrongCountsPlan = refingerprintPlan(wrongCounts);

            const cases = [
              executionRecoveryReadiness(staleSnapshot, readyPlan),
              executionRecoveryReadiness(readySnapshot, wrongSnapshotBinding),
              executionRecoveryReadiness(readySnapshot, tamperedPlanFingerprint),
              executionRecoveryReadiness(readySnapshot, mismatchedItemPlan),
              executionRecoveryReadiness(readySnapshot, missingPlan),
              executionRecoveryReadiness(readySnapshot, extraPlan),
              executionRecoveryReadiness(readySnapshot, duplicatePlan),
              executionRecoveryReadiness(readySnapshot, wrongCountsPlan),
              executionRecoveryReadiness(blockedSnapshot, blockedPlan),
            ];

            assert.ok(cases.every((value) => value.ready === false));
            assert.ok(cases.every((value) => value.execution === false));
            assert.ok(cases.every((value) => value.network_access === false));
            assert.ok(cases.every((value) => value.external_mutation === false));
            assert.ok(cases.every((value) => Number.isInteger(value.counts.orders)));
            assert.ok(cases.every((value) => value.counts.orders >= 0 && value.counts.orders <= 1024));
            assert.equal(cases.at(-1).reason, 'blocked');
            assert.ok(['snapshot_invalid', 'snapshot_plan_mismatch', 'plan_invalid', 'plan_not_canonical'].includes(cases[0].reason));
            """
        )


if __name__ == "__main__":
    unittest.main()
