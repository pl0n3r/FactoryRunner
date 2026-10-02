"""Aceptación de BrowserLoopRequest dentro de RuntimeSupervisor (#157)."""
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
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { RuntimeSupervisor } from './src/runtime-supervisor.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const NOW = 2200;

const identity = {
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.4',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 1,
};

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:157',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 2100,
  expires_at: 2300,
  instruction_ref: 'controlbot:instruction:factoryrunner-157',
};
const orderHash = orderFingerprint(order);

function signedAdmission() {
  const core = {
    version: 1,
    decision: 'ALLOW',
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    work_item_id: order.work_item_id,
    observed_at: NOW,
    order_fingerprint: orderHash,
    manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function signedPlan(admission) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: orderHash,
    admission_fingerprint: admission.fingerprint,
    adapter_id: 'browser-execution',
    manifest_fingerprint: admission.manifest_fingerprint,
    resource_fingerprint: admission.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

class FakeDriver {
  commands = [];
  async execute(command) {
    this.commands.push(structuredClone(command));
    return { status: 'ok', ref: 'browserref:element-157' };
  }
}

function ids(values) {
  const queue = [...values];
  return () => queue.shift() ?? '99999999-9999-7999-8999-999999999999';
}

async function scenario(kind) {
  const root = mkdtempSync(join(tmpdir(), 'factoryrunner-157-'));
  const journalPath = join(root, 'journal.ndjson');
  const outboxPath = join(root, 'outbox.ndjson');
  const journal = new DurableJournal(journalPath);
  const outbox = new DurableOutbox(outboxPath);
  const driver = new FakeDriver();
  const counts = { poll: 0, ack: 0, publish: 0, resolver: 0 };
  const published = [];

  const admission = signedAdmission();
  const plan = signedPlan(admission);
  const step = browserPlanStep(order, plan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: 'https://example.com/runtime-supervisor' },
  });
  const request = browserLoopRequest(order, plan, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });

  const client = {
    async poll() {
      counts.poll += 1;
      return { cursor: null, orders: [{ ...order, fingerprint: orderHash }] };
    },
    validatedOrder(orderId) {
      if (orderId !== ORDER_ID) throw new TypeError('unknown order');
      return order;
    },
    async ack() { counts.ack += 1; },
    async publishEvents(events) {
      counts.publish += 1;
      published.push(events.map((event) => ({
        state: event.state,
        code: event.evidence.code,
      })));
    },
    async publishHeartbeat() {},
  };

  const loop = new ExecutionLoop({
    journal,
    registry: new AdapterRegistry([{
      id: 'git-adapter',
      capabilities: ['git.head'],
      async execute(capability) {
        return {
          capability,
          data: Object.freeze({ unused: true }),
          evidence: { code: 'unused', summary: 'unused', ref: null },
        };
      },
    }]),
    browser_adapter: new BrowserExecutionAdapter(
      driver,
      ['https://example.com'],
      {
        runner_id: RUNNER_ID,
        order_id: ORDER_ID,
        location: 'hostinger-shared',
      },
    ),
    identity,
    now: () => NOW,
    event_id: ids([
      '44444444-4444-7444-8444-444444444444',
      '55555555-5555-7555-8555-555555555555',
    ]),
  });

  const dependencies = {
    client,
    journal,
    outbox,
    loop,
    admission: () => admission,
    plan: () => plan,
    now: () => NOW,
    event_id: ids(['33333333-3333-7333-8333-333333333333']),
  };

  if (kind !== 'missing') {
    dependencies.browser_request = (_validatedOrder, validatedPlan) => {
      counts.resolver += 1;
      if (kind === 'tampered') {
        return { ...request, plan_fingerprint: 'f'.repeat(64) };
      }
      if (validatedPlan.fingerprint !== plan.fingerprint) {
        throw new TypeError('unexpected plan');
      }
      return request;
    };
  }

  const supervisor = new RuntimeSupervisor(dependencies);
  let result = null;
  let error = null;
  try {
    result = await supervisor.tick(1);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  let journalRaw = '';
  let outboxRaw = '';
  try { journalRaw = readFileSync(journalPath, 'utf8'); } catch {}
  try { outboxRaw = readFileSync(outboxPath, 'utf8'); } catch {}

  const observed = {
    result,
    error,
    counts,
    commands: driver.commands,
    events: journal.recover().events.map((event) => ({
      state: event.state,
      code: event.evidence.code,
    })),
    published,
    delivered: outbox.recover().delivered.map((delivery) => delivery.kind),
    journalRaw,
    outboxRaw,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

console.log(JSON.stringify({
  valid: await scenario('valid'),
  missing: await scenario('missing'),
  tampered: await scenario('tampered'),
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


class FactoryRunnerBrowserRuntimeSupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_routes_plan_bound_browser_request_through_execution_loop(self):
        valid = self.observed["valid"]
        self.assertEqual(valid["result"], {"processed": 1, "cursor": None})
        self.assertIsNone(valid["error"])
        self.assertEqual(
            valid["counts"],
            {"poll": 1, "ack": 1, "publish": 1, "resolver": 1},
        )
        self.assertEqual(len(valid["commands"]), 1)
        self.assertEqual(valid["commands"][0]["kind"], "navigate")
        self.assertEqual(
            valid["commands"][0]["url"],
            "https://example.com/runtime-supervisor",
        )
        self.assertEqual(
            valid["events"],
            [
                {"state": "accepted", "code": "accepted"},
                {"state": "started", "code": "started"},
                {"state": "completed", "code": "browser-completed"},
            ],
        )
        self.assertEqual(
            valid["published"],
            [[{"state": "completed", "code": "browser-completed"}]],
        )
        self.assertEqual(valid["delivered"], ["ack", "plan-events"])
        self.assertNotIn(
            "https://example.com/runtime-supervisor",
            valid["journalRaw"],
        )
        self.assertNotIn(
            "https://example.com/runtime-supervisor",
            valid["outboxRaw"],
        )

    def test_missing_or_invalid_browser_request_blocks_before_fake_driver(self):
        for key in ("missing", "tampered"):
            with self.subTest(case=key):
                observed = self.observed[key]
                self.assertIsNone(observed["result"])
                self.assertIsNotNone(observed["error"])
                self.assertEqual(observed["counts"]["poll"], 1)
                self.assertEqual(observed["counts"]["ack"], 0)
                self.assertEqual(observed["counts"]["publish"], 0)
                self.assertEqual(observed["commands"], [])
                self.assertEqual(observed["events"], [])
                self.assertEqual(observed["delivered"], [])
                self.assertEqual(observed["journalRaw"], "")
                self.assertEqual(observed["outboxRaw"], "")


if __name__ == "__main__":
    unittest.main()
