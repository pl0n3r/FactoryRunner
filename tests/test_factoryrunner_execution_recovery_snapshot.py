"""Executable acceptance for reconciled journal + outbox recovery snapshots."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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


class FactoryRunnerExecutionRecoverySnapshotTests(unittest.TestCase):
    def test_snapshot_joins_journal_and_outbox_by_exact_order_plan_and_delivery_identity(self) -> None:
        run_node(
            r"""
            import assert from 'node:assert/strict';
            import { executionRecoverySnapshot } from './src/execution-recovery-snapshot.ts';
            import { orderFingerprint } from './src/order.ts';
            import { stableSha256 } from './src/validation.ts';

            const runnerId = '11111111-1111-7111-8111-111111111111';
            const orderId = '22222222-2222-7222-8222-222222222222';
            const secondOrderId = '55555555-5555-7555-8555-555555555555';
            const planFingerprint = 'b'.repeat(64);

            const order = {
              version: 1,
              order_id: orderId,
              work_item_id: 'work:recovery:one',
              runner_id: runnerId,
              capability: 'programmatic',
              attempt: 1,
              issued_at: 1_000,
              expires_at: 2_000,
              instruction_ref: 'controlbot:order:one',
            };
            const secondOrder = {
              ...order,
              order_id: secondOrderId,
              work_item_id: 'work:recovery:two',
              instruction_ref: 'controlbot:order:two',
            };
            const event = (eventId, sequence, state, occurredAt) => ({
              version: 1,
              event_id: eventId,
              order_id: orderId,
              runner_id: runnerId,
              sequence,
              state,
              occurred_at: occurredAt,
              evidence: { code: state, summary: `state ${state}`, ref: null },
            });
            const accepted = event('33333333-3333-7333-8333-333333333331', 1, 'accepted', 1_010);
            const started = event('33333333-3333-7333-8333-333333333332', 2, 'started', 1_020);
            const completed = event('33333333-3333-7333-8333-333333333333', 3, 'completed', 1_030);

            const delivery = (kind, request, plan = null) => {
              const core = kind === 'plan-events'
                ? { kind, plan_fingerprint: plan, request }
                : { kind, request };
              const fingerprint = stableSha256(core);
              return {
                version: 1,
                kind,
                delivery_id: `outbox:${kind}:${fingerprint}`,
                fingerprint,
                ...(kind === 'plan-events' ? { plan_fingerprint: plan } : {}),
                request,
              };
            };
            const ack = delivery('ack', {
              version: 1,
              order_id: orderId,
              runner_id: runnerId,
              fingerprint: orderFingerprint(order),
            });
            const terminal = delivery('plan-events', {
              version: 1,
              runner_id: runnerId,
              events: [completed],
            }, planFingerprint);

            const journal = {
              orders: [secondOrder, order],
              events: [accepted, started, completed],
            };
            const outbox = { pending: [terminal], delivered: [ack] };
            const snapshot = executionRecoverySnapshot(journal, outbox);

            assert.equal(snapshot.version, 1);
            assert.deepEqual(snapshot.counts, {
              orders: 2,
              events: 3,
              pending_deliveries: 1,
              delivered_deliveries: 1,
            });
            assert.deepEqual(snapshot.executions.map((item) => item.order_id), [orderId, secondOrderId]);
            const recovered = snapshot.executions[0];
            assert.equal(recovered.recovery, 'terminal');
            assert.equal(recovered.order_fingerprint, orderFingerprint(order));
            assert.equal(recovered.plan_fingerprint, planFingerprint);
            assert.equal(recovered.last_event_id, completed.event_id);
            assert.equal(recovered.counts.events, 3);
            assert.deepEqual(
              recovered.deliveries.map((item) => [item.kind, item.state, item.event_ids]),
              [
                ['ack', 'delivered', []],
                ['plan-events', 'pending', [completed.event_id]],
              ],
            );
            assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
            assert.match(recovered.fingerprint, /^[0-9a-f]{64}$/);

            const reordered = executionRecoverySnapshot(
              { orders: [order, secondOrder], events: [accepted, started, completed] },
              { pending: [terminal], delivered: [ack] },
            );
            assert.equal(reordered.fingerprint, snapshot.fingerprint);
            """
        )

    def test_conflicting_missing_or_mixed_recovery_evidence_fails_closed(self) -> None:
        run_node(
            r"""
            import assert from 'node:assert/strict';
            import { executionRecoverySnapshot } from './src/execution-recovery-snapshot.ts';
            import { orderFingerprint } from './src/order.ts';
            import { stableSha256 } from './src/validation.ts';

            const runnerId = '11111111-1111-7111-8111-111111111111';
            const orderId = '22222222-2222-7222-8222-222222222222';
            const unknownOrderId = '66666666-6666-7666-8666-666666666666';
            const order = {
              version: 1,
              order_id: orderId,
              work_item_id: 'work:recovery:one',
              runner_id: runnerId,
              capability: 'programmatic',
              attempt: 1,
              issued_at: 1_000,
              expires_at: 2_000,
              instruction_ref: 'controlbot:order:one',
            };
            const event = (eventId, sequence, state, summary = `state ${state}`) => ({
              version: 1,
              event_id: eventId,
              order_id: orderId,
              runner_id: runnerId,
              sequence,
              state,
              occurred_at: 1_000 + sequence * 10,
              evidence: { code: state, summary, ref: null },
            });
            const accepted = event('33333333-3333-7333-8333-333333333331', 1, 'accepted');
            const started = event('33333333-3333-7333-8333-333333333332', 2, 'started');
            const completed = event('33333333-3333-7333-8333-333333333333', 3, 'completed');
            const journal = { orders: [order], events: [accepted, started, completed] };

            const delivery = (kind, request, plan = null) => {
              const core = kind === 'plan-events'
                ? { kind, plan_fingerprint: plan, request }
                : { kind, request };
              const fingerprint = stableSha256(core);
              return {
                version: 1,
                kind,
                delivery_id: `outbox:${kind}:${fingerprint}`,
                fingerprint,
                ...(kind === 'plan-events' ? { plan_fingerprint: plan } : {}),
                request,
              };
            };

            const wrongAck = delivery('ack', {
              version: 1,
              order_id: orderId,
              runner_id: runnerId,
              fingerprint: 'a'.repeat(64),
            });
            assert.throws(
              () => executionRecoverySnapshot(journal, { pending: [wrongAck], delivered: [] }),
              /ACK fingerprint does not match recovered order identity/,
            );

            const missingAck = delivery('ack', {
              version: 1,
              order_id: unknownOrderId,
              runner_id: runnerId,
              fingerprint: 'c'.repeat(64),
            });
            assert.throws(
              () => executionRecoverySnapshot(journal, { pending: [missingAck], delivered: [] }),
              /references an unknown order/,
            );

            const plainEvents = delivery('events', {
              version: 1,
              runner_id: runnerId,
              events: [accepted, started, completed],
            });
            const planEvents = delivery('plan-events', {
              version: 1,
              runner_id: runnerId,
              events: [completed],
            }, 'b'.repeat(64));
            assert.throws(
              () => executionRecoverySnapshot(
                journal,
                { pending: [plainEvents, planEvents], delivered: [] },
              ),
              /Mixed plan-bound and unbound delivery evidence/,
            );

            const conflictingCompleted = event(
              completed.event_id,
              completed.sequence,
              completed.state,
              'conflicting terminal evidence',
            );
            const conflictingPlan = delivery('plan-events', {
              version: 1,
              runner_id: runnerId,
              events: [conflictingCompleted],
            }, 'b'.repeat(64));
            assert.throws(
              () => executionRecoverySnapshot(journal, { pending: [conflictingPlan], delivered: [] }),
              /event does not match journal evidence/,
            );

            const goodAck = delivery('ack', {
              version: 1,
              order_id: orderId,
              runner_id: runnerId,
              fingerprint: orderFingerprint(order),
            });
            assert.throws(
              () => executionRecoverySnapshot(journal, { pending: [goodAck], delivered: [goodAck] }),
              /duplicate or mixed delivery state/,
            );
            """
        )


if __name__ == "__main__":
    unittest.main()
