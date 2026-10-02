"""Aceptación del request browser plan-bound previo al ExecutionLoop (#146)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlanBatch } from './src/browser-plan-batch.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';

function order(orderId, capability = 'browser.navigate') {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:146',
    runner_id: RUNNER_ID,
    capability,
    attempt: 1,
    issued_at: 1100,
    expires_at: 1300,
    instruction_ref: 'controlbot:instruction:factoryrunner-146',
  };
}

function plan(orderInput, adapterId = 'browser-execution') {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: orderInput.runner_id,
    order_id: orderInput.order_id,
    work_item_id: orderInput.work_item_id,
    capability: orderInput.capability,
    order_fingerprint: orderFingerprint(orderInput),
    admission_fingerprint: 'a'.repeat(64),
    adapter_id: adapterId,
    manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64),
  };
  return { ...core, fingerprint: stableSha256(core) };
}

const orderA = order('22222222-2222-7222-8222-222222222222');
const planA = plan(orderA);
const stepA = browserPlanStep(orderA, planA, {
  version: 1,
  adapter_id: 'browser-execution',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/a' },
});
const stepA2 = browserPlanStep(orderA, planA, {
  version: 1,
  adapter_id: 'browser-execution',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/b' },
});
const batchA = browserPlanBatch([
  { index: 0, step: stepA },
  { index: 1, step: stepA2 },
]);

const stepRequest = browserLoopRequest(orderA, planA, {
  version: 1,
  browser_kind: 'step',
  browser: stepA,
});
const batchRequest = browserLoopRequest(orderA, planA, {
  version: 1,
  browser_kind: 'batch',
  browser: batchA,
});

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const orderB = order('33333333-3333-7333-8333-333333333333');
const planB = plan(orderB);
const stepB = browserPlanStep(orderB, planB, {
  version: 1,
  adapter_id: 'browser-execution',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/other' },
});

const mixedPlanRejected = rejected(() =>
  browserLoopRequest(orderA, planA, {
    version: 1,
    browser_kind: 'batch',
    browser: {
      ...batchA,
      steps: [
        { index: 0, step: stepA },
        { index: 1, step: stepB },
      ],
    },
  })
);

const capabilityDriftRejected = rejected(() =>
  browserLoopRequest(orderA, planA, {
    version: 1,
    browser_kind: 'step',
    browser: { ...stepA, capability: 'browser.close', payload: {} },
  })
);

const extraMaterialRejected = rejected(() =>
  browserLoopRequest(orderA, planA, {
    version: 1,
    browser_kind: 'step',
    browser: stepA,
    token: 'not-allowed',
  })
);

const typeOrder = order(
  '44444444-4444-7444-8444-444444444444',
  'browser.type_ref',
);
const typePlan = plan(typeOrder);
const sensitiveMaterialRejected = rejected(() =>
  browserLoopRequest(typeOrder, typePlan, {
    version: 1,
    browser_kind: 'step',
    browser: {
      version: 1,
      authority: 'unchanged',
      order_id: typeOrder.order_id,
      runner_id: RUNNER_ID,
      plan_fingerprint: typePlan.fingerprint,
      adapter_id: 'browser-execution',
      capability: 'browser.type_ref',
      payload: { ref: 'node:123', text: 'token=super-secret-value' },
      fingerprint: 'f'.repeat(64),
    },
  })
);

console.log(JSON.stringify({
  stepRequest,
  batchRequest,
  stepFrozen: Object.isFrozen(stepRequest),
  batchFrozen: Object.isFrozen(batchRequest),
  serializedStep: JSON.stringify(stepRequest),
  serializedBatch: JSON.stringify(batchRequest),
  mixedPlanRejected,
  capabilityDriftRejected,
  extraMaterialRejected,
  sensitiveMaterialRejected,
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


class FactoryRunnerBrowserLoopRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_request_binds_order_plan_and_browser_step_without_sensitive_material(self):
        for key, kind in (("stepRequest", "step"), ("batchRequest", "batch")):
            request = self.observed[key]
            self.assertEqual(request["version"], 1)
            self.assertEqual(request["authority"], "unchanged")
            self.assertEqual(request["order_id"], "22222222-2222-7222-8222-222222222222")
            self.assertEqual(request["runner_id"], "11111111-1111-7111-8111-111111111111")
            self.assertEqual(request["work_item_id"], "factoryrunner:work:146")
            self.assertEqual(request["adapter_id"], "browser-execution")
            self.assertEqual(request["capability"], "browser.navigate")
            self.assertEqual(request["browser_kind"], kind)
            self.assertEqual(request["browser_fingerprint"], request["browser"]["fingerprint"])
            self.assertEqual(request["plan_fingerprint"], request["browser"]["plan_fingerprint"])
            self.assertRegex(request["fingerprint"], r"^[0-9a-f]{64}$")

        self.assertTrue(self.observed["stepFrozen"])
        self.assertTrue(self.observed["batchFrozen"])

        combined = (
            self.observed["serializedStep"] + self.observed["serializedBatch"]
        ).lower()
        for forbidden in (
            "instruction_ref",
            "admission_fingerprint",
            "manifest_fingerprint",
            "resource_fingerprint",
            "password=",
            "token=",
            "secret=",
            "cookie=",
            "authorization=",
            "private_key",
        ):
            self.assertNotIn(forbidden, combined)

    def test_mixed_plan_capability_drift_or_extra_material_fails_closed(self):
        self.assertTrue(self.observed["mixedPlanRejected"])
        self.assertTrue(self.observed["capabilityDriftRejected"])
        self.assertTrue(self.observed["extraMaterialRejected"])
        self.assertTrue(self.observed["sensitiveMaterialRejected"])


if __name__ == "__main__":
    unittest.main()
