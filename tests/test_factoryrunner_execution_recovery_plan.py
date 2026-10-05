"""Executable acceptance for the local fail-closed recovery planner."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-plan.ts"


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
const canonicalSnapshot = snapshotOf([
  blockedTerminal,
  redeliverTerminal,
  noopTerminal,
  resumeInterrupted,
]);
"""


class FactoryRunnerExecutionRecoveryPlanTests(unittest.TestCase):
    def test_plan_classifies_noop_redeliver_resume_or_block_from_reconciled_snapshot(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const plan = executionRecoveryPlan(canonicalSnapshot);
            assert.equal(plan.version, 1);
            assert.equal(plan.authority, 'unchanged');
            assert.equal(plan.snapshot_fingerprint, canonicalSnapshot.fingerprint);
            assert.equal(plan.execution, false);
            assert.equal(plan.network_access, false);
            assert.equal(plan.external_mutation, false);
            assert.deepEqual(plan.counts, { noop: 1, redeliver: 1, resume: 1, block: 1 });

            const byOrder = new Map(plan.items.map((item) => [item.order_id, item]));
            assert.equal(byOrder.get(noopTerminal.order_id).action, 'noop');
            assert.equal(byOrder.get(noopTerminal.order_id).reason, 'terminal-result-delivered');
            assert.deepEqual(byOrder.get(noopTerminal.order_id).delivery_ids, []);

            const redeliver = byOrder.get(redeliverTerminal.order_id);
            assert.equal(redeliver.action, 'redeliver');
            assert.equal(redeliver.reason, 'terminal-result-pending');
            assert.deepEqual(
              redeliver.delivery_ids,
              redeliverTerminal.deliveries
                .filter((item) => item.kind === 'events')
                .map((item) => item.delivery_id),
            );

            assert.equal(byOrder.get(resumeInterrupted.order_id).action, 'resume');
            assert.equal(byOrder.get(resumeInterrupted.order_id).reason, 'execution-interrupted');
            assert.equal(byOrder.get(blockedTerminal.order_id).action, 'block');
            assert.equal(
              byOrder.get(blockedTerminal.order_id).reason,
              'terminal-delivery-evidence-incomplete',
            );

            for (const item of plan.items) {
              assert.equal(item.execution, false);
              assert.equal(item.network_access, false);
              assert.equal(item.external_mutation, false);
              assert.match(item.fingerprint, /^[0-9a-f]{64}$/);
            }
            assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
            assert.equal(executionRecoveryPlan(canonicalSnapshot).fingerprint, plan.fingerprint);
            """
        )

    def test_plan_never_executes_network_browser_git_or_external_mutation(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
            "ControlBotClient",
            "BrowserExecutionAdapter",
            "fetch(",
            "exec(",
            "spawn(",
        ):
            self.assertNotIn(forbidden, source)

        run_node(
            NODE_FIXTURE
            + r"""
            const before = JSON.stringify(canonicalSnapshot);
            const tampered = Object.freeze({
              ...canonicalSnapshot,
              fingerprint: '0'.repeat(64),
            });
            globalThis.fetch = () => { throw new Error('network access attempted'); };

            const blocked = executionRecoveryPlan(tampered);
            assert.equal(blocked.counts.block, canonicalSnapshot.executions.length);
            assert.equal(blocked.counts.noop, 0);
            assert.equal(blocked.counts.redeliver, 0);
            assert.equal(blocked.counts.resume, 0);
            assert.ok(blocked.items.every((item) => item.action === 'block'));
            assert.ok(blocked.items.every((item) => item.reason === 'snapshot-integrity-invalid'));
            assert.equal(blocked.execution, false);
            assert.equal(blocked.network_access, false);
            assert.equal(blocked.external_mutation, false);
            assert.equal(JSON.stringify(canonicalSnapshot), before);
            """
        )


if __name__ == "__main__":
    unittest.main()
