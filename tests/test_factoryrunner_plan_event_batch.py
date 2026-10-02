"""Aceptación ejecutable del batch terminal ligado al ExecutionPlan FactoryRunner #116."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerPlanEventBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { capabilityManifest } from './src/capability-manifest.ts';
        import { executionAdmissionDecision } from './src/execution-admission.ts';
        import { executionPlan } from './src/execution-plan.ts';
        import { planEventBatch } from './src/plan-event-batch.ts';
        import { resourceSnapshot } from './src/resource-snapshot.ts';

        const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
        const ORDER_ID = '22222222-2222-7222-8222-222222222222';
        const NOW = 1200;
        const identity = {
          version: 1,
          runner_id: RUNNER_ID,
          protocol_version: 1,
          runtime: 'node',
          runtime_version: '0.1.4',
          platform: 'linux-arm64',
          location: 'test',
          capabilities: ['git.head'],
          max_parallel: 1,
        };
        const order = {
          version: 1,
          order_id: ORDER_ID,
          work_item_id: 'factoryrunner:work:116',
          runner_id: RUNNER_ID,
          capability: 'git.head',
          attempt: 1,
          issued_at: 1100,
          expires_at: 1300,
          instruction_ref: 'controlbot:instruction:factoryrunner-116',
        };
        const manifest = capabilityManifest(identity, [{
          id: 'git-adapter',
          capabilities: ['git.head'],
        }]);
        const resource = resourceSnapshot(
          identity,
          {
            version: 1,
            runner_id: RUNNER_ID,
            sequence: 7,
            observed_at: 1190,
            status: 'ready',
            capacity: { max: 1, active: 0 },
            active_sessions: [],
          },
          {
            version: 1,
            runner_id: RUNNER_ID,
            observed_at: 1190,
            queued_orders: 1,
          },
          NOW,
          30,
        );
        const admission = executionAdmissionDecision(identity, order, manifest, resource, NOW);
        const plan = executionPlan(order, admission, manifest);
        const terminal = {
          version: 1,
          event_id: '33333333-3333-7333-8333-333333333333',
          order_id: ORDER_ID,
          runner_id: RUNNER_ID,
          sequence: 3,
          state: 'completed',
          occurred_at: 1210,
          evidence: {
            code: 'completed',
            summary: 'Synthetic terminal result',
            ref: null,
          },
        };

        const rejected = (action) => {
          try {
            action();
            return false;
          } catch {
            return true;
          }
        };

        const batch = planEventBatch(order, [terminal], plan);
        const nonterminalRejected = rejected(() => planEventBatch(order, [{
          ...terminal,
          event_id: '44444444-4444-7444-8444-444444444444',
          state: 'progress',
        }], plan));
        const orderMismatchRejected = rejected(() => planEventBatch(order, [{
          ...terminal,
          event_id: '55555555-5555-7555-8555-555555555555',
          order_id: '66666666-6666-7666-8666-666666666666',
        }], plan));
        const runnerMismatchRejected = rejected(() => planEventBatch(order, [{
          ...terminal,
          event_id: '77777777-7777-7777-8777-777777777777',
          runner_id: '88888888-8888-7888-8888-888888888888',
        }], plan));
        const invalidPlanRejected = rejected(() => planEventBatch(
          order,
          [terminal],
          { ...plan, fingerprint: 'f'.repeat(64) },
        ));
        const rawPayloadRejected = rejected(() => planEventBatch(order, [{
          ...terminal,
          payload: { token: 'raw-secret-payload' },
        }], plan));

        console.log(JSON.stringify({
          batch,
          planFingerprint: plan.fingerprint,
          frozen: Object.isFrozen(batch),
          eventsFrozen: Object.isFrozen(batch.events),
          eventFrozen: Object.isFrozen(batch.events[0]),
          evidenceFrozen: Object.isFrozen(batch.events[0].evidence),
          nonterminalRejected,
          orderMismatchRejected,
          runnerMismatchRejected,
          invalidPlanRejected,
          rawPayloadRejected,
          serialized: JSON.stringify(batch),
        }));
        """
        output = subprocess.check_output(
            (
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "-e",
                script,
            ),
            cwd=ROOT,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=20,
        )
        cls.observed = json.loads(output)

    def test_batch_binds_terminal_events_to_exact_plan_fingerprint_without_raw_payloads(self):
        observed = self.observed
        batch = observed["batch"]

        self.assertEqual(batch["version"], 1)
        self.assertEqual(batch["authority"], "unchanged")
        self.assertEqual(batch["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(batch["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(batch["plan_fingerprint"], observed["planFingerprint"])
        self.assertRegex(batch["plan_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(batch["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(batch["events"]), 1)
        self.assertEqual(batch["events"][0]["state"], "completed")
        self.assertEqual(batch["events"][0]["evidence"]["code"], "completed")
        self.assertEqual(batch["events"][0]["evidence"]["summary"], "Synthetic terminal result")
        self.assertTrue(observed["frozen"])
        self.assertTrue(observed["eventsFrozen"])
        self.assertTrue(observed["eventFrozen"])
        self.assertTrue(observed["evidenceFrozen"])

        serialized = observed["serialized"].lower()
        for forbidden in (
            "instruction_ref",
            "controlbot:instruction",
            "work_item_id",
            "payload",
            "raw-secret-payload",
            "password",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_mismatched_nonterminal_or_invalid_plan_fails_closed(self):
        self.assertTrue(self.observed["nonterminalRejected"])
        self.assertTrue(self.observed["orderMismatchRejected"])
        self.assertTrue(self.observed["runnerMismatchRejected"])
        self.assertTrue(self.observed["invalidPlanRejected"])
        self.assertTrue(self.observed["rawPayloadRejected"])


if __name__ == "__main__":
    unittest.main()
