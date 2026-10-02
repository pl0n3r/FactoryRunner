"""Aceptación ejecutable del binding resultado/outbox al ExecutionPlan FactoryRunner #105."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerPlanResultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { capabilityManifest } from './src/capability-manifest.ts';
        import { executionAdmissionDecision } from './src/execution-admission.ts';
        import { executionPlan } from './src/execution-plan.ts';
        import { DurableOutbox } from './src/outbox.ts';
        import { planResultEnvelope } from './src/result.ts';
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
          work_item_id: 'factoryrunner:work:105',
          runner_id: RUNNER_ID,
          capability: 'git.head',
          attempt: 1,
          issued_at: 1100,
          expires_at: 1300,
          instruction_ref: 'controlbot:instruction:factoryrunner-105',
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

        const envelope = planResultEnvelope(order, terminal, plan);
        const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-plan-result-105-'));
        try {
          const path = join(directory, 'outbox.ndjson');
          const outbox = new DurableOutbox(path);
          const request = { version: 1, runner_id: RUNNER_ID, events: [terminal] };
          const delivery = outbox.enqueuePlanEvents(request, envelope.plan_fingerprint);
          const replay = outbox.enqueuePlanEvents(request, envelope.plan_fingerprint);

          let mismatchRejected = false;
          try {
            outbox.enqueuePlanEvents(request, 'f'.repeat(64));
          } catch {
            mismatchRejected = true;
          }

          let planMismatchRejected = false;
          try {
            planResultEnvelope(order, terminal, { ...plan, fingerprint: 'f'.repeat(64) });
          } catch {
            planMismatchRejected = true;
          }

          console.log(JSON.stringify({
            envelope,
            frozen: Object.isFrozen(envelope),
            evidenceFrozen: Object.isFrozen(envelope.evidence),
            delivery,
            replaySame: replay.delivery_id === delivery.delivery_id,
            mismatchRejected,
            planMismatchRejected,
            recovered: outbox.recover(),
            serialized: JSON.stringify({ envelope, delivery }),
          }));
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
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

    def test_terminal_result_and_outbox_reference_plan_fingerprint_without_sensitive_payloads(self):
        observed = self.observed
        envelope = observed["envelope"]
        delivery = observed["delivery"]

        self.assertEqual(envelope["authority"], "unchanged")
        self.assertEqual(envelope["plan_fingerprint"], delivery["plan_fingerprint"])
        self.assertRegex(envelope["plan_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(envelope["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(observed["frozen"])
        self.assertTrue(observed["evidenceFrozen"])
        self.assertEqual(delivery["kind"], "plan-events")
        self.assertTrue(observed["replaySame"])
        self.assertEqual(len(observed["recovered"]["pending"]), 1)

        serialized = observed["serialized"]
        for forbidden in (
            "instruction_ref",
            "controlbot:instruction",
            "payload",
            "token",
            "secret",
            "password",
        ):
            self.assertNotIn(forbidden, serialized.lower())

    def test_replay_or_mismatched_plan_fingerprint_fails_closed(self):
        self.assertTrue(self.observed["mismatchRejected"])
        self.assertTrue(self.observed["planMismatchRejected"])


if __name__ == "__main__":
    unittest.main()
