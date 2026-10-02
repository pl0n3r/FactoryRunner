"""Aceptación ejecutable de ExecutionAdmissionDecision FactoryRunner #96."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { capabilityManifest } from './src/capability-manifest.ts';
        import { executionAdmissionDecision } from './src/execution-admission.ts';
        import { resourceSnapshot } from './src/resource-snapshot.ts';
        import { parseRunnerIdentity } from './src/runner.ts';

        const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
        const OTHER_RUNNER_ID = '99999999-9999-7999-8999-999999999999';
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

        function order(overrides = {}) {
          return {
            version: 1,
            order_id: '22222222-2222-7222-8222-222222222222',
            work_item_id: 'factoryrunner:work:96',
            runner_id: RUNNER_ID,
            capability: 'git.head',
            attempt: 1,
            issued_at: 1100,
            expires_at: 1300,
            instruction_ref: 'controlbot:instruction:factoryrunner-96',
            ...overrides,
          };
        }

        function resources(active = 0, status = 'ready') {
          return resourceSnapshot(
            identity,
            {
              version: 1,
              runner_id: RUNNER_ID,
              sequence: 7,
              observed_at: 1190,
              status,
              capacity: { max: 1, active },
              active_sessions: active === 0 ? [] : ['factoryrunner:session:busy'],
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
        }

        const fresh = resources();
        const zero = resources(1, 'busy');

        const allow = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          fresh,
          NOW,
        );
        const wait = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          zero,
          NOW,
        );
        const stale = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          { ...fresh, freshness: 'stale' },
          NOW,
        );
        const manifestDrift = executionAdmissionDecision(
          identity,
          order(),
          { ...manifest, runner_id: OTHER_RUNNER_ID },
          fresh,
          NOW,
        );
        const resourceDrift = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          { ...fresh, runner_id: OTHER_RUNNER_ID },
          NOW,
        );
        const unknown = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          { ...fresh, runner_status: 'unknown', available: 0, dispatchable_orders: 0 },
          NOW,
        );
        const capacityDrift = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          { ...fresh, available: 1, active: 1 },
          NOW,
        );
        const expired = executionAdmissionDecision(
          identity,
          order({ expires_at: 1199 }),
          manifest,
          fresh,
          NOW,
        );
        const draining = executionAdmissionDecision(
          identity,
          order(),
          manifest,
          resources(0, 'draining'),
          NOW,
        );

        console.log(JSON.stringify({
          allow,
          wait,
          stale,
          manifestDrift,
          resourceDrift,
          unknown,
          capacityDrift,
          expired,
          draining,
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

    def test_admission_allows_only_matching_executable_order_manifest_and_fresh_capacity(self):
        allow = self.observed["allow"]
        self.assertEqual(allow["decision"], "ALLOW")
        self.assertEqual(allow["authority"], "unchanged")
        self.assertEqual(
            allow["runner_id"],
            "11111111-1111-7111-8111-111111111111",
        )
        self.assertEqual(
            allow["order_id"],
            "22222222-2222-7222-8222-222222222222",
        )
        self.assertEqual(allow["work_item_id"], "factoryrunner:work:96")
        self.assertEqual(allow["observed_at"], 1190)
        self.assertEqual(allow["reasons"], ["admission_evidence_coherent"])
        for field in (
            "order_fingerprint",
            "manifest_fingerprint",
            "resource_fingerprint",
            "fingerprint",
        ):
            self.assertRegex(allow[field], r"^[0-9a-f]{64}$")

    def test_zero_capacity_waits_and_invalid_drift_or_stale_input_blocks_fail_closed(self):
        wait = self.observed["wait"]
        self.assertEqual(wait["decision"], "WAIT_CAPACITY")
        self.assertEqual(wait["authority"], "unchanged")
        self.assertEqual(wait["reasons"], ["capacity_unavailable"])

        for key in (
            "stale",
            "manifestDrift",
            "resourceDrift",
            "unknown",
            "capacityDrift",
            "expired",
        ):
            with self.subTest(case=key):
                decision = self.observed[key]
                self.assertEqual(decision["decision"], "BLOCKED")
                self.assertEqual(decision["authority"], "unchanged")
                self.assertIn("admission_evidence_invalid", decision["reasons"])

        draining = self.observed["draining"]
        self.assertEqual(draining["decision"], "BLOCKED")
        self.assertEqual(draining["authority"], "unchanged")
        self.assertEqual(draining["reasons"], ["runner_not_dispatchable"])


if __name__ == "__main__":
    unittest.main()
