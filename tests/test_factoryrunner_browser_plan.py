"""Aceptación del browser step puro ligado al ExecutionPlan (#134)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserPlanStep } from './src/browser-plan.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const runner = '11111111-1111-7111-8111-111111111111';
const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:134',
  runner_id: runner,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-134',
};
const planCore = {
  version: 1,
  authority: 'unchanged',
  runner_id: runner,
  order_id: order.order_id,
  work_item_id: order.work_item_id,
  capability: order.capability,
  order_fingerprint: orderFingerprint(order),
  admission_fingerprint: 'a'.repeat(64),
  adapter_id: 'browser-adapter',
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };

const step = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'browser-adapter',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/path?q=1' },
});

const acceptedCapabilities = [
  ['browser.navigate', { url: 'https://example.com/' }],
  ['browser.click_ref', { ref: 'node:123' }],
  ['browser.type_ref', { ref: 'node:456', text: 'safe synthetic text' }],
  ['browser.close', {}],
].map(([capability, payload]) => {
  const candidateOrder = { ...order, capability };
  const candidatePlanCore = {
    ...planCore,
    capability,
    order_fingerprint: orderFingerprint(candidateOrder),
  };
  const candidatePlan = {
    ...candidatePlanCore,
    fingerprint: stableSha256(candidatePlanCore),
  };
  return browserPlanStep(candidateOrder, candidatePlan, {
    version: 1,
    adapter_id: 'browser-adapter',
    capability,
    payload,
  }).capability;
});

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const adapterMismatchRejected = rejected(() => browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'other-adapter',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/' },
}));

const capabilityMismatchRejected = rejected(() => browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'browser-adapter',
  capability: 'browser.click_ref',
  payload: { ref: 'node:123' },
}));

const extraFieldRejected = rejected(() => browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'browser-adapter',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/', selector: '#unsafe' },
}));

const sensitivePayloadRejected = rejected(() => {
  const typeOrder = { ...order, capability: 'browser.type_ref' };
  const typePlanCore = {
    ...planCore,
    capability: 'browser.type_ref',
    order_fingerprint: orderFingerprint(typeOrder),
  };
  const typePlan = { ...typePlanCore, fingerprint: stableSha256(typePlanCore) };
  browserPlanStep(typeOrder, typePlan, {
    version: 1,
    adapter_id: 'browser-adapter',
    capability: 'browser.type_ref',
    payload: { ref: 'node:456', text: 'token=super-secret-value' },
  });
});

console.log(JSON.stringify({
  step,
  frozen: Object.isFrozen(step),
  payloadFrozen: Object.isFrozen(step.payload),
  planFingerprint: plan.fingerprint,
  acceptedCapabilities,
  adapterMismatchRejected,
  capabilityMismatchRejected,
  extraFieldRejected,
  sensitivePayloadRejected,
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


class FactoryRunnerBrowserPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_step_binds_exact_plan_fingerprint_adapter_and_existing_browser_capability(self):
        step = self.observed["step"]
        self.assertEqual(step["version"], 1)
        self.assertEqual(step["authority"], "unchanged")
        self.assertEqual(step["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(step["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(step["plan_fingerprint"], self.observed["planFingerprint"])
        self.assertEqual(step["adapter_id"], "browser-adapter")
        self.assertEqual(step["capability"], "browser.navigate")
        self.assertEqual(step["payload"], {"url": "https://example.com/path?q=1"})
        self.assertRegex(step["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            self.observed["acceptedCapabilities"],
            ["browser.navigate", "browser.click_ref", "browser.type_ref", "browser.close"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["payloadFrozen"])

    def test_mismatched_adapter_capability_or_extra_fields_fail_closed_without_effect(self):
        self.assertTrue(self.observed["adapterMismatchRejected"])
        self.assertTrue(self.observed["capabilityMismatchRejected"])
        self.assertTrue(self.observed["extraFieldRejected"])
        self.assertTrue(self.observed["sensitivePayloadRejected"])


if __name__ == "__main__":
    unittest.main()
