"""Aceptación del pin exacto de binding remoto para dispatch (#202)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteDispatchBinding } from './src/browser-remote-dispatch-binding.ts';
import { stableSha256 } from './src/validation.ts';

function signed(core) {
  return { ...core, fingerprint: stableSha256(core) };
}

const PLAN_FP_SEED = {
  version: 1,
  authority: 'unchanged',
  runner_id: '11111111-1111-7111-8111-111111111111',
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:202',
  capability: 'browser.navigate',
  order_fingerprint: 'a'.repeat(64),
  admission_fingerprint: 'b'.repeat(64),
  adapter_id: 'browser-execution',
  manifest_fingerprint: 'c'.repeat(64),
  resource_fingerprint: 'd'.repeat(64),
};
const plan = signed(PLAN_FP_SEED);

const request = signed({
  version: 1,
  authority: 'unchanged',
  order_id: plan.order_id,
  runner_id: plan.runner_id,
  work_item_id: plan.work_item_id,
  plan_fingerprint: plan.fingerprint,
  adapter_id: plan.adapter_id,
  capability: plan.capability,
  browser_kind: 'step',
  browser_fingerprint: 'e'.repeat(64),
  browser: Object.freeze({ version: 1, opaque: 'canonical-browser-step' }),
});

const placementEvidence = signed({
  version: 1,
  authority: 'unchanged',
  order_fingerprint: plan.order_fingerprint,
  plan_fingerprint: plan.fingerprint,
  request_fingerprint: request.fingerprint,
  placement_fingerprint: 'f'.repeat(64),
  binding_fingerprint: '1'.repeat(64),
});

const binding = browserRemoteDispatchBinding(plan, request, placementEvidence);

let mixedRequestError = null;
try {
  const mixedRequest = signed({
    ...request,
    plan_fingerprint: '2'.repeat(64),
    fingerprint: undefined,
  });
  delete mixedRequest.fingerprint;
  mixedRequest.fingerprint = stableSha256(mixedRequest);
  browserRemoteDispatchBinding(plan, mixedRequest, placementEvidence);
} catch (error) {
  mixedRequestError = error instanceof Error ? error.message : String(error);
}

let tamperedBindingError = null;
try {
  browserRemoteDispatchBinding(
    plan,
    request,
    { ...placementEvidence, binding_fingerprint: '3'.repeat(64) },
  );
} catch (error) {
  tamperedBindingError = error instanceof Error ? error.message : String(error);
}

let mixedOrderError = null;
try {
  const otherPlan = signed({
    ...PLAN_FP_SEED,
    order_fingerprint: '4'.repeat(64),
  });
  const otherRequest = signed({
    ...request,
    plan_fingerprint: otherPlan.fingerprint,
    fingerprint: undefined,
  });
  delete otherRequest.fingerprint;
  otherRequest.fingerprint = stableSha256(otherRequest);
  const otherEvidence = signed({
    ...placementEvidence,
    plan_fingerprint: otherPlan.fingerprint,
    request_fingerprint: otherRequest.fingerprint,
    fingerprint: undefined,
  });
  delete otherEvidence.fingerprint;
  otherEvidence.fingerprint = stableSha256(otherEvidence);
  browserRemoteDispatchBinding(otherPlan, otherRequest, otherEvidence);
} catch (error) {
  mixedOrderError = error instanceof Error ? error.message : String(error);
}

console.log(JSON.stringify({
  binding,
  frozen: Object.isFrozen(binding),
  fingerprintCoherent: binding.fingerprint === stableSha256({
    version: binding.version,
    authority: binding.authority,
    plan_fingerprint: binding.plan_fingerprint,
    request_fingerprint: binding.request_fingerprint,
    placement_evidence_fingerprint: binding.placement_evidence_fingerprint,
    binding_fingerprint: binding.binding_fingerprint,
  }),
  expected: {
    plan: plan.fingerprint,
    request: request.fingerprint,
    placementEvidence: placementEvidence.fingerprint,
    remoteBinding: placementEvidence.binding_fingerprint,
  },
  mixedRequestError,
  tamperedBindingError,
  mixedOrderError,
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


class FactoryRunnerBrowserRemoteBindingPinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_placement_evidence_pins_exact_binding_fingerprint_for_dispatch(self):
        binding = self.observed["binding"]
        expected = self.observed["expected"]

        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["fingerprintCoherent"])
        self.assertEqual(binding["version"], 1)
        self.assertEqual(binding["authority"], "unchanged")
        self.assertEqual(binding["plan_fingerprint"], expected["plan"])
        self.assertEqual(binding["request_fingerprint"], expected["request"])
        self.assertEqual(
            binding["placement_evidence_fingerprint"],
            expected["placementEvidence"],
        )
        self.assertEqual(binding["binding_fingerprint"], expected["remoteBinding"])

    def test_pin_rejects_request_plan_or_binding_mismatch_without_transport(self):
        self.assertIsNotNone(self.observed["mixedRequestError"])
        self.assertIsNotNone(self.observed["tamperedBindingError"])
        self.assertIsNotNone(self.observed["mixedOrderError"])


if __name__ == "__main__":
    unittest.main()
