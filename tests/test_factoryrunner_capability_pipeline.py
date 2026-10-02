"""Aceptación end-to-end de gramática capability en identity→manifest→admission→plan (#140)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { capabilityManifest } from './src/capability-manifest.ts';
import { executionAdmissionDecision } from './src/execution-admission.ts';
import { executionPlan } from './src/execution-plan.ts';
import { parseRunnerIdentity } from './src/runner.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const NOW = 1200;

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

function pipeline(capability, orderId) {
  const identity = parseRunnerIdentity({
    version: 1,
    runner_id: RUNNER_ID,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.0',
    platform: 'linux-arm64',
    location: 'hostinger-shared',
    capabilities: [capability],
    max_parallel: 1,
  });
  const manifest = capabilityManifest(identity, [{
    id: 'browser-execution',
    capabilities: [capability],
  }]);
  const order = {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:140',
    runner_id: RUNNER_ID,
    capability,
    attempt: 1,
    issued_at: 1100,
    expires_at: 1300,
    instruction_ref: 'controlbot:instruction:factoryrunner-140',
  };
  const resources = resourceSnapshot(
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
  const admission = executionAdmissionDecision(identity, order, manifest, resources, NOW);
  const plan = executionPlan(order, admission, manifest);
  return { identity, manifest, admission, plan };
}

const click = pipeline('browser.click_ref', '22222222-2222-7222-8222-222222222222');
const type = pipeline('browser.type_ref', '33333333-3333-7333-8333-333333333333');

const malformedIdentityRejected = rejected(() => parseRunnerIdentity({
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser..click'],
  max_parallel: 1,
}));

const validIdentity = parseRunnerIdentity({
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.click_ref'],
  max_parallel: 1,
});
const malformedManifestRejected = rejected(() => capabilityManifest(validIdentity, [{
  id: 'browser-execution',
  capabilities: ['browser._ref'],
}]));

const malformedOrder = {
  version: 1,
  order_id: '44444444-4444-7444-8444-444444444444',
  work_item_id: 'factoryrunner:work:140-malformed',
  runner_id: RUNNER_ID,
  capability: 'browser.click_',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-140',
};
const resources = resourceSnapshot(
  validIdentity,
  {
    version: 1,
    runner_id: RUNNER_ID,
    sequence: 8,
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
const validManifest = capabilityManifest(validIdentity, [{
  id: 'browser-execution',
  capabilities: ['browser.click_ref'],
}]);
const malformedAdmission = executionAdmissionDecision(
  validIdentity,
  malformedOrder,
  validManifest,
  resources,
  NOW,
);
const malformedPlanRejected = rejected(() =>
  executionPlan(malformedOrder, malformedAdmission, validManifest)
);

const fingerprintDriftRejected = rejected(() =>
  executionPlan(
    {
      version: 1,
      order_id: '55555555-5555-7555-8555-555555555555',
      work_item_id: 'factoryrunner:work:140-drift',
      runner_id: RUNNER_ID,
      capability: 'browser.click_ref',
      attempt: 1,
      issued_at: 1100,
      expires_at: 1300,
      instruction_ref: 'controlbot:instruction:factoryrunner-140',
    },
    click.admission,
    { ...click.manifest, fingerprint: 'f'.repeat(64) },
  )
);

console.log(JSON.stringify({
  click,
  type,
  malformedIdentityRejected,
  malformedManifestRejected,
  malformedAdmissionDecision: malformedAdmission.decision,
  malformedPlanRejected,
  fingerprintDriftRejected,
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerCapabilityPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_browser_ref_capabilities_survive_identity_manifest_admission_and_execution_plan(self):
        for key, capability in (
            ("click", "browser.click_ref"),
            ("type", "browser.type_ref"),
        ):
            result = self.observed[key]
            self.assertEqual(result["identity"]["capabilities"], [capability])
            self.assertEqual(result["manifest"]["capabilities"], [capability])
            self.assertEqual(
                result["manifest"]["adapters"],
                [{"adapter_id": "browser-execution", "capabilities": [capability]}],
            )
            self.assertEqual(result["admission"]["decision"], "ALLOW")
            self.assertEqual(result["plan"]["capability"], capability)
            self.assertEqual(result["plan"]["adapter_id"], "browser-execution")
            self.assertEqual(
                result["plan"]["manifest_fingerprint"],
                result["manifest"]["fingerprint"],
            )
            self.assertRegex(result["plan"]["fingerprint"], r"^[0-9a-f]{64}$")

    def test_malformed_capabilities_still_fail_closed_across_pipeline(self):
        self.assertTrue(self.observed["malformedIdentityRejected"])
        self.assertTrue(self.observed["malformedManifestRejected"])
        self.assertEqual(self.observed["malformedAdmissionDecision"], "BLOCKED")
        self.assertTrue(self.observed["malformedPlanRejected"])
        self.assertTrue(self.observed["fingerprintDriftRejected"])


if __name__ == "__main__":
    unittest.main()
