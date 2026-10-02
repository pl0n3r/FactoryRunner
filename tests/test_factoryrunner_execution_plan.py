"""Aceptación ejecutable del ExecutionPlan FactoryRunner #103."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerExecutionPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { capabilityManifest } from './src/capability-manifest.ts';
        import { executionAdmissionDecision } from './src/execution-admission.ts';
        import { executionPlan } from './src/execution-plan.ts';
        import { resourceSnapshot } from './src/resource-snapshot.ts';
        import { parseRunnerIdentity } from './src/runner.ts';
        import { stableSha256 } from './src/validation.ts';

        const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
        const NOW = 1200;
        const identity = parseRunnerIdentity({
          version: 1,
          runner_id: RUNNER_ID,
          protocol_version: 1,
          runtime: 'node',
          runtime_version: '0.1.4',
          platform: 'linux-arm64',
          location: 'test',
          capabilities: ['git.head'],
          max_parallel: 1,
        });
        const manifest = capabilityManifest(identity, [{
          id: 'git-adapter',
          capabilities: ['git.head'],
        }]);
        const order = {
          version: 1,
          order_id: '22222222-2222-7222-8222-222222222222',
          work_item_id: 'factoryrunner:work:103',
          runner_id: RUNNER_ID,
          capability: 'git.head',
          attempt: 1,
          issued_at: 1100,
          expires_at: 1300,
          instruction_ref: 'controlbot:instruction:factoryrunner-103',
        };
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
        const admission = executionAdmissionDecision(
          identity,
          order,
          manifest,
          resource,
          NOW,
        );
        const plan = executionPlan(order, admission, manifest);

        function rehashManifest(overrides) {
          const { fingerprint: _ignored, ...base } = manifest;
          const core = { ...base, ...overrides };
          return { ...core, fingerprint: stableSha256(core) };
        }

        function rehashAdmission(overrides) {
          const { fingerprint: _ignored, ...base } = admission;
          const core = { ...base, ...overrides };
          return { ...core, fingerprint: stableSha256(core) };
        }

        function rejected(callback) {
          try {
            callback();
            return false;
          } catch {
            return true;
          }
        }

        const missingAdapter = rehashManifest({
          adapters: [{ adapter_id: 'other-adapter', capabilities: ['other.cap'] }],
        });
        const ambiguousAdapter = rehashManifest({
          adapters: [
            { adapter_id: 'git-adapter', capabilities: ['git.head'] },
            { adapter_id: 'git-adapter-secondary', capabilities: ['git.head'] },
          ],
        });
        const authorityDrift = rehashAdmission({ authority: 'expanded' });
        const manifestDrift = rehashAdmission({
          manifest_fingerprint: 'f'.repeat(64),
        });

        order.instruction_ref = 'controlbot:instruction:mutated-after-plan';
        manifest.adapters[0].adapter_id = 'mutated-after-plan';

        console.log(JSON.stringify({
          plan,
          frozen: Object.isFrozen(plan),
          serialized: JSON.stringify(plan),
          rejects: {
            missingAdapter: rejected(() => executionPlan(
              { ...order, instruction_ref: 'controlbot:instruction:factoryrunner-103' },
              admission,
              missingAdapter,
            )),
            ambiguousAdapter: rejected(() => executionPlan(
              { ...order, instruction_ref: 'controlbot:instruction:factoryrunner-103' },
              admission,
              ambiguousAdapter,
            )),
            authorityDrift: rejected(() => executionPlan(
              { ...order, instruction_ref: 'controlbot:instruction:factoryrunner-103' },
              authorityDrift,
              rehashManifest({}),
            )),
            manifestDrift: rejected(() => executionPlan(
              { ...order, instruction_ref: 'controlbot:instruction:factoryrunner-103' },
              manifestDrift,
              rehashManifest({}),
            )),
          },
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

    def test_plan_binds_admitted_order_adapter_manifest_and_resource_fingerprints_without_raw_payloads(self):
        plan = self.observed["plan"]
        self.assertEqual(plan["version"], 1)
        self.assertEqual(plan["authority"], "unchanged")
        self.assertEqual(plan["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(plan["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(plan["work_item_id"], "factoryrunner:work:103")
        self.assertEqual(plan["capability"], "git.head")
        self.assertEqual(plan["adapter_id"], "git-adapter")
        self.assertTrue(self.observed["frozen"])
        for field in (
            "order_fingerprint",
            "admission_fingerprint",
            "manifest_fingerprint",
            "resource_fingerprint",
            "fingerprint",
        ):
            self.assertRegex(plan[field], r"^[0-9a-f]{64}$")
        serialized = self.observed["serialized"]
        self.assertNotIn("instruction_ref", serialized)
        self.assertNotIn("controlbot:instruction", serialized)
        self.assertNotIn("payload", serialized)
        self.assertNotIn("mutated-after-plan", serialized)

    def test_missing_or_ambiguous_adapter_or_authority_drift_blocks_plan_fail_closed(self):
        self.assertEqual(
            self.observed["rejects"],
            {
                "missingAdapter": True,
                "ambiguousAdapter": True,
                "authorityDrift": True,
                "manifestDrift": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
