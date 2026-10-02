"""Aceptación de recovery browser en RuntimeSupervisor (#158)."""
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
const NOW = 3200;

const identity = {
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.4',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate', 'browser.type_ref'],
  max_parallel: 1,
};

function makeOrder(orderId, capability, suffix) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: `factoryrunner:work:158:${suffix}`,
    runner_id: RUNNER_ID,
    capability,
    attempt: 1,
    issued_at: 3100,
    expires_at: 3300,
    instruction_ref: `controlbot:instruction:factoryrunner-158:${suffix}`,
  };
}

function signedAdmission(order) {
  const core = {
    version: 1,
    decision: 'ALLOW',
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    observed_at: NOW,
    order_fingerprint: orderFingerprint(order),
    manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function signedPlan(order, admission) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: order.order_id,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: orderFingerprint(order),
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
    return { status: 'ok', ref: 'browserref:result-158' };
  }
}

function dummyRegistry() {
  return new AdapterRegistry([{
    id: 'git-adapter',
    capabilities: ['git.head'],
    async execute(capability) {
      return {
        capability,
        data: Object.freeze({ unused: true }),
        evidence: { code: 'unused', summary: 'unused', ref: null },
      };
    },
  }]);
}

function ids(values) {
  const queue = [...values];
  return () => queue.shift() ?? '99999999-9999-7999-8999-999999999999';
}

function buildSupervisor({
  order,
  admission,
  plan,
  request,
  journal,
  outbox,
  driver,
  counts,
  published,
  loopIds,
  supervisorIds,
}) {
  const client = {
    async poll() {
      counts.poll += 1;
      return {
        version: 1,
        cursor: null,
        orders: [{ ...order, fingerprint: orderFingerprint(order) }],
      };
    },
    validatedOrder(orderId) {
      if (orderId !== order.order_id) throw new TypeError('unknown order');
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
    registry: dummyRegistry(),
    browser_adapter: new BrowserExecutionAdapter(
      driver,
      ['https://example.com'],
      {
        runner_id: RUNNER_ID,
        order_id: order.order_id,
        location: 'hostinger-shared',
      },
    ),
    identity,
    now: () => NOW,
    event_id: ids(loopIds),
  });

  return new RuntimeSupervisor({
    client,
    journal,
    outbox,
    loop,
    admission: () => admission,
    plan: () => plan,
    browser_request: () => {
      counts.resolver += 1;
      return request;
    },
    now: () => NOW,
    event_id: ids(supervisorIds),
  });
}

async function terminalScenario(root) {
  const order = makeOrder(
    '22222222-2222-7222-8222-222222222222',
    'browser.navigate',
    'terminal',
  );
  const admission = signedAdmission(order);
  const plan = signedPlan(order, admission);
  const step = browserPlanStep(order, plan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: 'https://example.com/runtime-recovery-secret-path' },
  });
  const request = browserLoopRequest(order, plan, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
  const journalPath = join(root, 'terminal-journal.ndjson');
  const outboxPath = join(root, 'terminal-outbox.ndjson');
  const journal = new DurableJournal(journalPath);
  const outbox = new DurableOutbox(outboxPath);
  const counts = { poll: 0, ack: 0, publish: 0, resolver: 0 };
  const published = [];

  const firstDriver = new FakeDriver();
  const first = await buildSupervisor({
    order, admission, plan, request, journal, outbox,
    driver: firstDriver, counts, published,
    loopIds: [
      '44444444-4444-7444-8444-444444444441',
      '55555555-5555-7555-8555-555555555551',
    ],
    supervisorIds: ['33333333-3333-7333-8333-333333333331'],
  }).tick(1);

  const restartDriver = new FakeDriver();
  const restarted = await buildSupervisor({
    order, admission, plan, request,
    journal: new DurableJournal(journalPath),
    outbox: new DurableOutbox(outboxPath),
    driver: restartDriver, counts, published,
    loopIds: [
      '44444444-4444-7444-8444-444444444442',
      '55555555-5555-7555-8555-555555555552',
    ],
    supervisorIds: ['33333333-3333-7333-8333-333333333332'],
  }).tick(1);

  return {
    first,
    restarted,
    counts,
    firstCommands: firstDriver.commands,
    restartCommands: restartDriver.commands,
    published,
    states: new DurableJournal(journalPath).recover().events.map((event) => ({
      state: event.state,
      code: event.evidence.code,
    })),
    delivered: new DurableOutbox(outboxPath).recover().delivered.map((item) => item.kind),
    journalRaw: readFileSync(journalPath, 'utf8'),
    outboxRaw: readFileSync(outboxPath, 'utf8'),
  };
}

async function interruptedScenario(root) {
  const order = makeOrder(
    '66666666-6666-7666-8666-666666666666',
    'browser.type_ref',
    'interrupted',
  );
  const admission = signedAdmission(order);
  const plan = signedPlan(order, admission);
  const step = browserPlanStep(order, plan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.type_ref',
    payload: {
      ref: 'browserref:element-sensitive-158',
      text: 'typed recovery payload secret 158',
    },
  });
  const request = browserLoopRequest(order, plan, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
  const journalPath = join(root, 'interrupted-journal.ndjson');
  const outboxPath = join(root, 'interrupted-outbox.ndjson');
  const journal = new DurableJournal(journalPath);
  const outbox = new DurableOutbox(outboxPath);
  journal.appendOrder(order);
  journal.appendEvent({
    version: 1,
    event_id: '77777777-7777-7777-8777-777777777771',
    order_id: order.order_id,
    runner_id: RUNNER_ID,
    sequence: 1,
    state: 'accepted',
    occurred_at: 3198,
    evidence: { code: 'accepted', summary: 'Order accepted before restart', ref: null },
  });
  journal.appendEvent({
    version: 1,
    event_id: '77777777-7777-7777-8777-777777777772',
    order_id: order.order_id,
    runner_id: RUNNER_ID,
    sequence: 2,
    state: 'started',
    occurred_at: 3199,
    evidence: { code: 'started', summary: 'Browser dispatch started before restart', ref: null },
  });

  const counts = { poll: 0, ack: 0, publish: 0, resolver: 0 };
  const published = [];
  const driver = new FakeDriver();
  const result = await buildSupervisor({
    order, admission, plan, request, journal, outbox, driver, counts, published,
    loopIds: ['88888888-8888-7888-8888-888888888881'],
    supervisorIds: ['88888888-8888-7888-8888-888888888882'],
  }).tick(1);

  return {
    result,
    counts,
    commands: driver.commands,
    published,
    states: journal.recover().events.map((event) => ({
      state: event.state,
      code: event.evidence.code,
      summary: event.evidence.summary,
    })),
    pending: outbox.recover().pending.map((item) => item.kind),
    delivered: outbox.recover().delivered.map((item) => item.kind),
    journalRaw: readFileSync(journalPath, 'utf8'),
    outboxRaw: readFileSync(outboxPath, 'utf8'),
  };
}

const root = mkdtempSync(join(tmpdir(), 'factoryrunner-158-'));
try {
  console.log(JSON.stringify({
    terminal: await terminalScenario(root),
    interrupted: await interruptedScenario(root),
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


class FactoryRunnerBrowserRuntimeRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_terminal_browser_runtime_is_reused_without_duplicate_driver_or_publish(self):
        observed = self.observed["terminal"]
        self.assertEqual(observed["first"], {"processed": 1, "cursor": None})
        self.assertEqual(observed["restarted"], {"processed": 1, "cursor": None})
        self.assertEqual(len(observed["firstCommands"]), 1)
        self.assertEqual(observed["restartCommands"], [])
        self.assertEqual(observed["counts"]["ack"], 1)
        self.assertEqual(observed["counts"]["publish"], 1)
        self.assertEqual(
            observed["published"],
            [[{"state": "completed", "code": "browser-completed"}]],
        )
        self.assertEqual(
            observed["states"],
            [
                {"state": "accepted", "code": "accepted"},
                {"state": "started", "code": "started"},
                {"state": "completed", "code": "browser-completed"},
            ],
        )
        self.assertEqual(observed["delivered"], ["ack", "plan-events"])
        for raw in (observed["journalRaw"].lower(), observed["outboxRaw"].lower()):
            self.assertNotIn("runtime-recovery-secret-path", raw)

    def test_interrupted_browser_runtime_fails_closed_without_replay_or_sensitive_outbox(self):
        observed = self.observed["interrupted"]
        self.assertEqual(observed["result"], {"processed": 1, "cursor": None})
        self.assertEqual(observed["commands"], [])
        self.assertEqual(observed["counts"]["ack"], 1)
        self.assertEqual(observed["counts"]["publish"], 1)
        self.assertEqual(
            observed["published"],
            [[{"state": "failed", "code": "restart-interrupted"}]],
        )
        self.assertEqual(
            [item["state"] for item in observed["states"]],
            ["accepted", "started", "failed"],
        )
        self.assertEqual(observed["states"][-1]["code"], "restart-interrupted")
        self.assertEqual(observed["pending"], [])
        self.assertEqual(observed["delivered"], ["ack", "plan-events"])

        raw = (observed["journalRaw"] + observed["outboxRaw"]).lower()
        for forbidden in (
            "typed recovery payload secret 158",
            "browserref:element-sensitive-158",
            "https://example.com",
            "authorization",
            "cookie",
            "storage",
            "password",
            "token",
            "secret 158",
        ):
            self.assertNotIn(forbidden, raw)


if __name__ == "__main__":
    unittest.main()
