"""Aceptación del adapter browser consumiendo únicamente steps plan-bound (#136)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserExecutionAdapter } from './src/adapters/browser.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const ADAPTER_ID = 'browser-execution';

class FakeDriver {
  commands = [];
  async execute(command) {
    this.commands.push(structuredClone(command));
    return { status: 'ok', ref: 'browserref:element-0001' };
  }
}

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:136',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-136',
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
const step = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: ADAPTER_ID,
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/path' },
});

const driver = new FakeDriver();
const adapter = new BrowserExecutionAdapter(
  driver,
  ['https://example.com'],
  { runner_id: RUNNER_ID, order_id: ORDER_ID, location: 'hostinger-shared' },
);
const result = await adapter.executePlanStep(order, plan, step);
const happyCommands = structuredClone(driver.commands);

const rejectedWithoutCommand = async (action) => {
  const before = driver.commands.length;
  try {
    await action();
    return false;
  } catch {
    return driver.commands.length === before;
  }
};

const adapterDriftRejected = await rejectedWithoutCommand(() =>
  adapter.executePlanStep(order, plan, { ...step, adapter_id: 'other-adapter' })
);
const fingerprintDriftRejected = await rejectedWithoutCommand(() =>
  adapter.executePlanStep(order, plan, { ...step, fingerprint: 'f'.repeat(64) })
);
const planDriftRejected = await rejectedWithoutCommand(() => {
  const driftPlanCore = { ...planCore, capability: 'browser.click_ref' };
  const driftPlan = { ...driftPlanCore, fingerprint: stableSha256(driftPlanCore) };
  return adapter.executePlanStep(order, driftPlan, step);
});

const otherContextDriver = new FakeDriver();
const otherContextAdapter = new BrowserExecutionAdapter(
  otherContextDriver,
  ['https://example.com'],
  {
    runner_id: RUNNER_ID,
    order_id: '33333333-3333-7333-8333-333333333333',
    location: 'hostinger-shared',
  },
);
let contextDriftRejected = false;
try {
  await otherContextAdapter.executePlanStep(order, plan, step);
} catch {
  contextDriftRejected = otherContextDriver.commands.length === 0;
}

console.log(JSON.stringify({
  result,
  happyCommands,
  totalCommands: driver.commands.length,
  adapterDriftRejected,
  fingerprintDriftRejected,
  planDriftRejected,
  contextDriftRejected,
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


class FactoryRunnerBrowserPlanAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_adapter_executes_only_exact_validated_plan_bound_step_with_fake_driver(self):
        observed = self.observed
        self.assertEqual(
            observed["result"],
            {
                "capability": "browser.navigate",
                "status": "ok",
                "ref": "browserref:element-0001",
            },
        )
        self.assertEqual(len(observed["happyCommands"]), 1)
        command = observed["happyCommands"][0]
        self.assertEqual(command["kind"], "navigate")
        self.assertEqual(command["url"], "https://example.com/path")
        self.assertRegex(command["session_key"], r"^browsersession:[0-9a-f]{64}$")

    def test_plan_or_adapter_drift_blocks_before_driver_execute(self):
        self.assertTrue(self.observed["adapterDriftRejected"])
        self.assertTrue(self.observed["fingerprintDriftRejected"])
        self.assertTrue(self.observed["planDriftRejected"])
        self.assertTrue(self.observed["contextDriftRejected"])
        self.assertEqual(self.observed["totalCommands"], 1)


if __name__ == "__main__":
    unittest.main()
