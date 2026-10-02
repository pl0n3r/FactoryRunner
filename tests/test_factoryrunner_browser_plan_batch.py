"""Aceptación del batch browser ligado a un único ExecutionPlan (#135)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserPlanStep } from './src/browser-plan.ts';
import { browserPlanBatch } from './src/browser-plan-batch.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const ADAPTER_ID = 'browser-adapter';

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:135',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-135',
};
const planCore = {
  version: 1,
  authority: 'unchanged',
  runner_id: RUNNER_ID,
  order_id: ORDER_ID,
  work_item_id: order.work_item_id,
  capability: order.capability,
  order_fingerprint: orderFingerprint(order),
  admission_fingerprint: 'a'.repeat(64),
  adapter_id: ADAPTER_ID,
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };

const stepA = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: ADAPTER_ID,
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/one' },
});
const stepB = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: ADAPTER_ID,
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/two' },
});

const batch = browserPlanBatch([
  { index: 0, step: stepA },
  { index: 1, step: stepB },
]);
const deterministic = browserPlanBatch([
  { index: 0, step: { ...stepA, payload: { ...stepA.payload } } },
  { index: 1, step: { ...stepB, payload: { ...stepB.payload } } },
]).fingerprint === batch.fingerprint;

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const tooManyRejected = rejected(() => browserPlanBatch(
  Array.from({ length: 33 }, (_, index) => ({ index, step: stepA })),
));
const duplicateIndexRejected = rejected(() => browserPlanBatch([
  { index: 0, step: stepA },
  { index: 0, step: stepB },
]));
const outOfOrderRejected = rejected(() => browserPlanBatch([
  { index: 1, step: stepA },
  { index: 0, step: stepB },
]));

const otherOrder = {
  ...order,
  order_id: '33333333-3333-7333-8333-333333333333',
  work_item_id: 'factoryrunner:work:other',
};
const otherPlanCore = {
  ...planCore,
  order_id: otherOrder.order_id,
  work_item_id: otherOrder.work_item_id,
  order_fingerprint: orderFingerprint(otherOrder),
};
const otherPlan = {
  ...otherPlanCore,
  fingerprint: stableSha256(otherPlanCore),
};
const otherStep = browserPlanStep(otherOrder, otherPlan, {
  version: 1,
  adapter_id: ADAPTER_ID,
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/other' },
});
const mixedPlanRejected = rejected(() => browserPlanBatch([
  { index: 0, step: stepA },
  { index: 1, step: otherStep },
]));

const { fingerprint: _stepFingerprint, ...sensitiveCore } = stepA;
const sensitivePayloadCore = {
  ...sensitiveCore,
  payload: { url: 'https://example.com/?token=super-secret-value' },
};
const sensitiveStep = {
  ...sensitivePayloadCore,
  fingerprint: stableSha256(sensitivePayloadCore),
};
const sensitiveMaterialRejected = rejected(() => browserPlanBatch([
  { index: 0, step: sensitiveStep },
]));

const { fingerprint: _safeFingerprint, ...rawCore } = stepA;
const rawPayloadCore = {
  ...rawCore,
  payload: {
    url: 'https://example.com/',
    headers: { authorization: 'Bearer synthetic-value' },
  },
};
const rawPayloadStep = {
  ...rawPayloadCore,
  fingerprint: stableSha256(rawPayloadCore),
};
const rawMaterialRejected = rejected(() => browserPlanBatch([
  { index: 0, step: rawPayloadStep },
]));

console.log(JSON.stringify({
  batch,
  planFingerprint: plan.fingerprint,
  deterministic,
  frozen: Object.isFrozen(batch),
  stepsFrozen: Object.isFrozen(batch.steps),
  itemsFrozen: batch.steps.every((item) => Object.isFrozen(item)),
  envelopesFrozen: batch.steps.every((item) => Object.isFrozen(item.step)),
  payloadsFrozen: batch.steps.every((item) => Object.isFrozen(item.step.payload)),
  tooManyRejected,
  duplicateIndexRejected,
  outOfOrderRejected,
  mixedPlanRejected,
  sensitiveMaterialRejected,
  rawMaterialRejected,
  serialized: JSON.stringify(batch),
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


class FactoryRunnerBrowserPlanBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_batch_is_bounded_ordered_and_bound_to_one_plan_without_sensitive_material(self):
        observed = self.observed
        batch = observed["batch"]

        self.assertEqual(batch["version"], 1)
        self.assertEqual(batch["authority"], "unchanged")
        self.assertEqual(batch["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(batch["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(batch["plan_fingerprint"], observed["planFingerprint"])
        self.assertEqual(batch["adapter_id"], "browser-adapter")
        self.assertEqual(batch["capability"], "browser.navigate")
        self.assertEqual([item["index"] for item in batch["steps"]], [0, 1])
        self.assertEqual(len(batch["steps"]), 2)
        self.assertRegex(batch["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(observed["deterministic"])
        self.assertTrue(observed["frozen"])
        self.assertTrue(observed["stepsFrozen"])
        self.assertTrue(observed["itemsFrozen"])
        self.assertTrue(observed["envelopesFrozen"])
        self.assertTrue(observed["payloadsFrozen"])
        self.assertTrue(observed["tooManyRejected"])

        serialized = observed["serialized"].lower()
        for forbidden in (
            "headers",
            "authorization",
            "cookie",
            "storage",
            "screenshot",
            "<html",
            "token=",
            "password=",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_mixed_plan_duplicate_order_or_sensitive_material_fails_closed(self):
        self.assertTrue(self.observed["mixedPlanRejected"])
        self.assertTrue(self.observed["duplicateIndexRejected"])
        self.assertTrue(self.observed["outOfOrderRejected"])
        self.assertTrue(self.observed["sensitiveMaterialRejected"])
        self.assertTrue(self.observed["rawMaterialRejected"])


if __name__ == "__main__":
    unittest.main()
