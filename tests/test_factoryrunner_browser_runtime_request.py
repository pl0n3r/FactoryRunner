"""Aceptación del resolver runtime browser plan-bound (#156)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { resolveBrowserRuntimeRequest } from './src/browser-runtime-request.ts';
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';

function order(orderId) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:156',
    runner_id: RUNNER_ID,
    capability: 'browser.navigate',
    attempt: 1,
    issued_at: 2100,
    expires_at: 2300,
    instruction_ref: 'controlbot:instruction:factoryrunner-156',
  };
}

function plan(orderInput) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: orderInput.runner_id,
    order_id: orderInput.order_id,
    work_item_id: orderInput.work_item_id,
    capability: orderInput.capability,
    order_fingerprint: orderFingerprint(orderInput),
    admission_fingerprint: 'a'.repeat(64),
    adapter_id: 'browser-execution',
    manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64),
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function request(orderInput, planInput, url) {
  const browser = browserPlanStep(orderInput, planInput, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url },
  });
  return browserLoopRequest(orderInput, planInput, {
    version: 1,
    browser_kind: 'step',
    browser,
  });
}

const orderA = order('22222222-2222-7222-8222-222222222222');
const planA = plan(orderA);
const requestA = request(orderA, planA, 'https://example.com/runtime');
const resolved = resolveBrowserRuntimeRequest(orderA, planA, requestA);

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const { plan_fingerprint: _missing, ...missingRequest } = requestA;
const missingRejected = rejected(() =>
  resolveBrowserRuntimeRequest(orderA, planA, missingRequest)
);

const orderB = order('33333333-3333-7333-8333-333333333333');
const planB = plan(orderB);
const mixedRejected = rejected(() =>
  resolveBrowserRuntimeRequest(orderB, planB, requestA)
);

const adapterTamperRejected = rejected(() =>
  resolveBrowserRuntimeRequest(orderA, planA, {
    ...requestA,
    adapter_id: 'other-browser',
  })
);

const fingerprintTamperRejected = rejected(() =>
  resolveBrowserRuntimeRequest(orderA, planA, {
    ...requestA,
    fingerprint: 'f'.repeat(64),
  })
);

const extraRejected = rejected(() =>
  resolveBrowserRuntimeRequest(orderA, planA, {
    ...requestA,
    token: 'not-allowed',
  })
);

console.log(JSON.stringify({
  resolved,
  frozen: Object.isFrozen(resolved),
  sameFingerprint: resolved.fingerprint === requestA.fingerprint,
  sameBrowserFingerprint: resolved.browser_fingerprint === requestA.browser_fingerprint,
  missingRejected,
  mixedRejected,
  adapterTamperRejected,
  fingerprintTamperRejected,
  extraRejected,
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


class FactoryRunnerBrowserRuntimeRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_runtime_request_resolver_preserves_order_plan_and_browser_binding(self):
        resolved = self.observed["resolved"]
        self.assertEqual(resolved["version"], 1)
        self.assertEqual(resolved["authority"], "unchanged")
        self.assertEqual(resolved["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(resolved["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(resolved["work_item_id"], "factoryrunner:work:156")
        self.assertEqual(resolved["adapter_id"], "browser-execution")
        self.assertEqual(resolved["capability"], "browser.navigate")
        self.assertEqual(resolved["browser_kind"], "step")
        self.assertEqual(resolved["browser_fingerprint"], resolved["browser"]["fingerprint"])
        self.assertEqual(resolved["plan_fingerprint"], resolved["browser"]["plan_fingerprint"])
        self.assertRegex(resolved["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["sameFingerprint"])
        self.assertTrue(self.observed["sameBrowserFingerprint"])

    def test_missing_mixed_or_tampered_runtime_request_fails_closed(self):
        for key in (
            "missingRejected",
            "mixedRejected",
            "adapterTamperRejected",
            "fingerprintTamperRejected",
            "extraRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])


if __name__ == "__main__":
    unittest.main()
