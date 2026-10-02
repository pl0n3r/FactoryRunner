"""Aceptación de recovery browser idempotente y anti-replay (#148)."""
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

class FakeDriver {
  commands = [];
  async execute(command) {
    this.commands.push(structuredClone(command));
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
  capabilities: ['browser.navigate', 'browser.type_ref'],
  max_parallel: 1,
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

function order(orderId, capability) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:148',
    runner_id: RUNNER_ID,
    capability,
    attempt: 1,
    issued_at: 1100,
    expires_at: 1300,
    instruction_ref: 'controlbot:instruction:factoryrunner-148',
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

function ids(start) {
  let sequence = start;
  return () => `00000000-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

const root = mkdtempSync(join(tmpdir(), 'factoryrunner-148-'));
try {
  const terminalOrder = order(
    '22222222-2222-7222-8222-222222222222',
    'browser.navigate',
  );
  const terminalPlan = plan(terminalOrder);
  const terminalStep = browserPlanStep(terminalOrder, terminalPlan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: 'https://example.com/recovery-path' },
  });
  const terminalRequest = browserLoopRequest(terminalOrder, terminalPlan, {
    version: 1,
    browser_kind: 'step',
    browser: terminalStep,
  });
  const terminalPath = join(root, 'terminal.ndjson');
  const terminalJournal = new DurableJournal(terminalPath);
  const firstDriver = new FakeDriver();
  const firstLoop = new ExecutionLoop({
    journal: terminalJournal,
    registry: dummyRegistry(),
    browser_adapter: new BrowserExecutionAdapter(
      firstDriver,
      ['https://example.com'],
      {
        runner_id: RUNNER_ID,
        order_id: terminalOrder.order_id,
        location: 'hostinger-shared',
      },
    ),
    identity,
    now: () => 1200,
    event_id: ids(1),
  });
  const first = await firstLoop.executeBrowserRequest(
    terminalOrder,
    terminalPlan,
    terminalRequest,
  );

  const restartDriver = new FakeDriver();
  const restartedLoop = new ExecutionLoop({
    journal: new DurableJournal(terminalPath),
    registry: dummyRegistry(),
    browser_adapter: new BrowserExecutionAdapter(
      restartDriver,
      ['https://example.com'],
      {
        runner_id: RUNNER_ID,
        order_id: terminalOrder.order_id,
        location: 'hostinger-shared',
      },
    ),
    identity,
    now: () => 1201,
    event_id: ids(100),
  });
  const reused = await restartedLoop.executeBrowserRequest(
    terminalOrder,
    terminalPlan,
    terminalRequest,
  );
  const terminalRecovered = new DurableJournal(terminalPath).recoverExecution(
    terminalOrder.order_id,
  );
  const terminalRaw = readFileSync(terminalPath, 'utf8');

  const interruptedOrder = order(
    '33333333-3333-7333-8333-333333333333',
    'browser.type_ref',
  );
  const interruptedPlan = plan(interruptedOrder);
  const interruptedStep = browserPlanStep(interruptedOrder, interruptedPlan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.type_ref',
    payload: {
      ref: 'browserref:element-0002',
      text: 'typed recovery payload',
    },
  });
  const interruptedRequest = browserLoopRequest(
    interruptedOrder,
    interruptedPlan,
    {
      version: 1,
      browser_kind: 'step',
      browser: interruptedStep,
    },
  );
  const interruptedPath = join(root, 'interrupted.ndjson');
  const interruptedJournal = new DurableJournal(interruptedPath);
  interruptedJournal.appendOrder(interruptedOrder);
  interruptedJournal.appendEvent({
    version: 1,
    event_id: '00000000-0000-7000-8000-000000000201',
    order_id: interruptedOrder.order_id,
    runner_id: RUNNER_ID,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1198,
    evidence: {
      code: 'accepted',
      summary: 'Validated order accepted by execution loop',
      ref: null,
    },
  });
  interruptedJournal.appendEvent({
    version: 1,
    event_id: '00000000-0000-7000-8000-000000000202',
    order_id: interruptedOrder.order_id,
    runner_id: RUNNER_ID,
    sequence: 2,
    state: 'started',
    occurred_at: 1199,
    evidence: {
      code: 'started',
      summary: 'Adapter dispatch started',
      ref: null,
    },
  });

  const interruptedDriver = new FakeDriver();
  const interruptedLoop = new ExecutionLoop({
    journal: interruptedJournal,
    registry: dummyRegistry(),
    browser_adapter: new BrowserExecutionAdapter(
      interruptedDriver,
      ['https://example.com'],
      {
        runner_id: RUNNER_ID,
        order_id: interruptedOrder.order_id,
        location: 'hostinger-shared',
      },
    ),
    identity,
    now: () => 1200,
    event_id: ids(300),
  });
  const interrupted = await interruptedLoop.executeBrowserRequest(
    interruptedOrder,
    interruptedPlan,
    interruptedRequest,
  );
  const interruptedRecovered = interruptedJournal.recoverExecution(
    interruptedOrder.order_id,
  );
  const interruptedRaw = readFileSync(interruptedPath, 'utf8');

  console.log(JSON.stringify({
    first,
    firstCommands: firstDriver.commands,
    reused,
    restartCommands: restartDriver.commands,
    terminalRecovery: terminalRecovered?.recovery,
    terminalEvents: terminalRecovered?.events ?? [],
    terminalRaw,
    interrupted,
    interruptedCommands: interruptedDriver.commands,
    interruptedRecovery: interruptedRecovered?.recovery,
    interruptedEvents: interruptedRecovered?.events ?? [],
    interruptedRaw,
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


class FactoryRunnerBrowserLoopRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_terminal_browser_execution_is_reused_without_duplicate_driver_effect(self):
        self.assertFalse(self.observed["first"]["reused"])
        self.assertEqual(self.observed["first"]["event"]["state"], "completed")
        self.assertEqual(len(self.observed["firstCommands"]), 1)

        reused = self.observed["reused"]
        self.assertTrue(reused["reused"])
        self.assertEqual(reused["event"]["state"], "completed")
        self.assertIsNone(reused["adapter_result"])
        self.assertEqual(self.observed["restartCommands"], [])
        self.assertEqual(self.observed["terminalRecovery"], "terminal")
        self.assertEqual(
            [event["state"] for event in self.observed["terminalEvents"]],
            ["accepted", "started", "completed"],
        )
        self.assertNotIn(
            "https://example.com/recovery-path",
            self.observed["terminalRaw"],
        )

    def test_interrupted_browser_execution_fails_closed_without_replay_or_sensitive_evidence(self):
        interrupted = self.observed["interrupted"]
        self.assertTrue(interrupted["reused"])
        self.assertEqual(interrupted["event"]["state"], "failed")
        self.assertEqual(interrupted["event"]["evidence"], {
            "code": "restart-interrupted",
            "summary": (
                "Recovered non-terminal execution; retry refused "
                "to avoid duplicate effect"
            ),
            "ref": None,
        })
        self.assertIsNone(interrupted["adapter_result"])
        self.assertEqual(self.observed["interruptedCommands"], [])
        self.assertEqual(self.observed["interruptedRecovery"], "terminal")
        self.assertEqual(
            [event["state"] for event in self.observed["interruptedEvents"]],
            ["accepted", "started", "failed"],
        )

        raw = self.observed["interruptedRaw"].lower()
        for forbidden in (
            "typed recovery payload",
            "browserref:element-0002",
            "https://example.com",
            "cookie=",
            "authorization=",
            "token=",
            "secret=",
            "password=",
        ):
            self.assertNotIn(forbidden, raw)


if __name__ == "__main__":
    unittest.main()
