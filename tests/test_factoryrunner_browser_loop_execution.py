"""Aceptación del ExecutionLoop con BrowserLoopRequest plan-bound (#147)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserExecutionAdapter } from './src/adapters/browser.ts';
import { AdapterRegistry } from './src/adapters/programmatic.ts';
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { ExecutionLoop } from './src/execution-loop.ts';
import { DurableJournal } from './src/journal.ts';
import { orderFingerprint } from './src/order.ts';
import { parseRunnerIdentity } from './src/runner.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';

class FakeDriver {
  commands = [];
  fail = false;

  async execute(command) {
    this.commands.push(structuredClone(command));
    if (this.fail) throw new Error('fake-driver-failure');
    return { status: 'ok', ref: 'browserref:element-0001' };
  }
}

const identity = parseRunnerIdentity({
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 1,
});

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:147',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-147',
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
  adapter_id: 'browser-execution',
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };
const step = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'browser-execution',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/path' },
});
const request = browserLoopRequest(order, plan, {
  version: 1,
  browser_kind: 'step',
  browser: step,
});

const dummyRegistry = () => new AdapterRegistry([{
  id: 'dummy-adapter',
  capabilities: ['git.head'],
  async execute(capability) {
    return {
      capability,
      data: Object.freeze({ unused: true }),
      evidence: { code: 'unused', summary: 'unused', ref: null },
    };
  },
}]);

const ids = () => {
  let sequence = 1;
  return () => `00000000-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
};

const root = mkdtempSync(join(tmpdir(), 'factoryrunner-147-'));
try {
  const successJournal = new DurableJournal(join(root, 'success.ndjson'));
  const successDriver = new FakeDriver();
  const successAdapter = new BrowserExecutionAdapter(
    successDriver,
    ['https://example.com'],
    { runner_id: RUNNER_ID, order_id: ORDER_ID, location: 'hostinger-shared' },
  );
  const successLoop = new ExecutionLoop({
    journal: successJournal,
    registry: dummyRegistry(),
    browser_adapter: successAdapter,
    identity,
    now: () => 1200,
    event_id: ids(),
  });
  const success = await successLoop.executeBrowserRequest(order, plan, request);
  const successRecovered = successJournal.recover();
  const successJournalRaw = readFileSync(join(root, 'success.ndjson'), 'utf8');

  const failedJournal = new DurableJournal(join(root, 'failed.ndjson'));
  const failedDriver = new FakeDriver();
  const wrongContextAdapter = new BrowserExecutionAdapter(
    failedDriver,
    ['https://example.com'],
    {
      runner_id: RUNNER_ID,
      order_id: '33333333-3333-7333-8333-333333333333',
      location: 'hostinger-shared',
    },
  );
  const failedLoop = new ExecutionLoop({
    journal: failedJournal,
    registry: dummyRegistry(),
    browser_adapter: wrongContextAdapter,
    identity,
    now: () => 1200,
    event_id: ids(),
  });
  const failed = await failedLoop.executeBrowserRequest(order, plan, request);
  const failedRecovered = failedJournal.recover();

  const tamperedJournal = new DurableJournal(join(root, 'tampered.ndjson'));
  const tamperedDriver = new FakeDriver();
  const tamperedAdapter = new BrowserExecutionAdapter(
    tamperedDriver,
    ['https://example.com'],
    { runner_id: RUNNER_ID, order_id: ORDER_ID, location: 'hostinger-shared' },
  );
  const tamperedLoop = new ExecutionLoop({
    journal: tamperedJournal,
    registry: dummyRegistry(),
    browser_adapter: tamperedAdapter,
    identity,
    now: () => 1200,
    event_id: ids(),
  });
  let tamperedRejected = false;
  try {
    await tamperedLoop.executeBrowserRequest(
      order,
      plan,
      { ...request, fingerprint: 'f'.repeat(64) },
    );
  } catch {
    tamperedRejected = (
      tamperedDriver.commands.length === 0
      && tamperedJournal.recover().orders.length === 0
      && tamperedJournal.recover().events.length === 0
    );
  }

  console.log(JSON.stringify({
    success,
    successEvents: successRecovered.events,
    successCommands: successDriver.commands,
    successJournalRaw,
    failed,
    failedEvents: failedRecovered.events,
    failedCommands: failedDriver.commands,
    tamperedRejected,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserLoopExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_plan_bound_browser_request_executes_through_loop_with_fake_driver(self):
        success = self.observed["success"]
        self.assertFalse(success["reused"])
        self.assertEqual(success["event"]["state"], "completed")
        self.assertEqual(success["event"]["evidence"], {
            "code": "browser-completed",
            "summary": "Browser plan-bound execution completed with 1 step(s)",
            "ref": None,
        })
        self.assertEqual(
            [event["state"] for event in self.observed["successEvents"]],
            ["accepted", "started", "completed"],
        )
        self.assertEqual(len(self.observed["successCommands"]), 1)
        command = self.observed["successCommands"][0]
        self.assertEqual(command["kind"], "navigate")
        self.assertEqual(command["url"], "https://example.com/path")
        self.assertRegex(command["session_key"], r"^browsersession:[0-9a-f]{64}$")
        self.assertEqual(success["adapter_result"], [{
            "capability": "browser.navigate",
            "status": "ok",
            "ref": "browserref:element-0001",
        }])
        self.assertNotIn("https://example.com/path", self.observed["successJournalRaw"])

    def test_invalid_binding_blocks_before_fake_driver_and_terminal_event_is_fail_closed(self):
        failed = self.observed["failed"]
        self.assertFalse(failed["reused"])
        self.assertEqual(failed["event"]["state"], "failed")
        self.assertEqual(failed["event"]["evidence"], {
            "code": "adapter-failed",
            "summary": "Adapter execution failed",
            "ref": None,
        })
        self.assertEqual(
            [event["state"] for event in self.observed["failedEvents"]],
            ["accepted", "started", "failed"],
        )
        self.assertEqual(self.observed["failedCommands"], [])
        self.assertIsNone(failed["adapter_result"])
        self.assertTrue(self.observed["tamperedRejected"])


if __name__ == "__main__":
    unittest.main()
