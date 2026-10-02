"""Aceptación de provenance local secret-free del ExecutionPlan (#118)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { orderFingerprint, parseExecutionOrder } from './src/order.ts';
import { planTelemetry } from './src/plan-telemetry.ts';
import { capability, slug, stableSha256 } from './src/validation.ts';

const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:118',
  runner_id: '11111111-1111-7111-8111-111111111111',
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-118',
};

const planCore = {
  version: 1,
  authority: 'unchanged',
  runner_id: order.runner_id,
  order_id: order.order_id,
  work_item_id: order.work_item_id,
  capability: order.capability,
  order_fingerprint: orderFingerprint(order),
  admission_fingerprint: 'a'.repeat(64),
  adapter_id: 'git-adapter',
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const telemetry = planTelemetry(order, plan, 'git-adapter');
const mismatchAdapterRejected = rejected(() => planTelemetry(order, plan, 'other-adapter'));
const sensitivePlanRejected = rejected(() => planTelemetry(
  order,
  { ...plan, token: 'super-secret-token' },
  'git-adapter',
));
const mismatchedOrderRejected = rejected(() => planTelemetry(
  { ...order, order_id: '33333333-3333-7333-8333-333333333333' },
  plan,
  'git-adapter',
));

const canonicalCapabilities = [
  'git',
  'git.head',
  'openai-api',
  'browser.click_ref',
  'browser.type_ref',
];
const acceptedCapabilities = canonicalCapabilities.map((candidate) => {
  const candidateOrder = { ...order, capability: candidate };
  const parsedOrder = parseExecutionOrder(candidateOrder);
  const candidatePlanCore = {
    ...planCore,
    capability: candidate,
    order_fingerprint: orderFingerprint(parsedOrder),
  };
  const candidatePlan = {
    ...candidatePlanCore,
    fingerprint: stableSha256(candidatePlanCore),
  };
  return {
    order: parsedOrder.capability,
    telemetry: planTelemetry(candidateOrder, candidatePlan, 'git-adapter').plan_fingerprint,
  };
});

const invalidCapabilities = [
  'Git',
  'browser click_ref',
  'browser..click',
  'browser._ref',
  'browser.click_',
  '_browser',
  'browser/close',
  'a'.repeat(65),
];
const boundedGrammarRejected = invalidCapabilities.every((candidate) =>
  rejected(() => capability(candidate, 'capability'))
);
const slugUnchanged = (
  slug('git.head', 'slug') === 'git.head'
  && rejected(() => slug('browser.click_ref', 'slug'))
);
const capabilityDriftRejected = rejected(() => {
  const driftOrder = { ...order, capability: 'browser.click_ref' };
  const parsedDriftOrder = parseExecutionOrder(driftOrder);
  const driftPlanCore = {
    ...planCore,
    capability: 'browser.type_ref',
    order_fingerprint: orderFingerprint(parsedDriftOrder),
  };
  const driftPlan = {
    ...driftPlanCore,
    fingerprint: stableSha256(driftPlanCore),
  };
  planTelemetry(driftOrder, driftPlan, 'git-adapter');
});

console.log(JSON.stringify({
  telemetry,
  frozen: Object.isFrozen(telemetry),
  serialized: JSON.stringify(telemetry),
  planFingerprint: plan.fingerprint,
  mismatchAdapterRejected,
  sensitivePlanRejected,
  mismatchedOrderRejected,
  acceptedCapabilities,
  boundedGrammarRejected,
  slugUnchanged,
  capabilityDriftRejected,
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


class FactoryRunnerPlanTelemetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_plan_telemetry_links_order_adapter_and_plan_fingerprints_without_sensitive_payloads(self):
        observed = self.observed
        telemetry = observed["telemetry"]

        self.assertEqual(telemetry["version"], 1)
        self.assertEqual(telemetry["authority"], "unchanged")
        self.assertEqual(telemetry["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(telemetry["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(telemetry["adapter_id"], "git-adapter")
        self.assertEqual(telemetry["plan_fingerprint"], observed["planFingerprint"])
        self.assertRegex(telemetry["plan_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(telemetry["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(observed["frozen"])

        serialized = observed["serialized"].lower()
        for forbidden in (
            "instruction_ref",
            "controlbot:instruction",
            "work_item_id",
            "capability",
            "payload",
            "token",
            "secret",
            "password",
            "credential",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_order_and_plan_telemetry_accept_canonical_browser_ref_capabilities(self):
        accepted = self.observed["acceptedCapabilities"]
        self.assertEqual(
            [entry["order"] for entry in accepted],
            ["git", "git.head", "openai-api", "browser.click_ref", "browser.type_ref"],
        )
        for entry in accepted:
            self.assertRegex(entry["telemetry"], r"^[0-9a-f]{64}$")

    def test_capability_grammar_remains_bounded_without_relaxing_slug(self):
        self.assertTrue(self.observed["boundedGrammarRejected"])
        self.assertTrue(self.observed["slugUnchanged"])
        self.assertTrue(self.observed["capabilityDriftRejected"])

    def test_mismatched_plan_adapter_or_sensitive_input_fails_closed(self):
        self.assertTrue(self.observed["mismatchAdapterRejected"])
        self.assertTrue(self.observed["sensitivePlanRejected"])
        self.assertTrue(self.observed["mismatchedOrderRejected"])


if __name__ == "__main__":
    unittest.main()
