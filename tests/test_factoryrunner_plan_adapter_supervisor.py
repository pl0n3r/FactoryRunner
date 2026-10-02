"""Aceptación del handoff supervisor→loop del ExecutionPlan (#112)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_scenarios() -> dict[str, object]:
    script = r"""
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { RuntimeSupervisor } from './src/runtime-supervisor.ts';
import { stableSha256 } from './src/validation.ts';

const runner = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const order = {
  version: 1,
  order_id: orderId,
  work_item_id: 'factoryrunner:work:112',
  runner_id: runner,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-112',
};
const admissionCore = {
  version: 1,
  decision: 'ALLOW',
  authority: 'unchanged',
  runner_id: runner,
  order_id: orderId,
  work_item_id: order.work_item_id,
  order_fingerprint: 'a'.repeat(64),
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const admission = { ...admissionCore, fingerprint: stableSha256(admissionCore) };

function plan(adapterId) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: runner,
    order_id: orderId,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: admission.order_fingerprint,
    admission_fingerprint: admission.fingerprint,
    adapter_id: adapterId,
    manifest_fingerprint: admission.manifest_fingerprint,
    resource_fingerprint: admission.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

async function scenario(drift) {
  const root = mkdtempSync(join(tmpdir(), 'fr-plan-supervisor-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  let planCalls = 0;
  let loopCalls = 0;
  let ackCalls = 0;
  let handedPlan = null;
  const generated = [];

  const client = {
    async poll() {
      return { version: 1, cursor: null, orders: [{ ...order, fingerprint: 'f'.repeat(64) }] };
    },
    validatedOrder() { return order; },
    async ack() { ackCalls += 1; },
    async publishEvents() {},
    async publishHeartbeat() {},
  };

  const loop = {
    async execute() { throw new Error('legacy path must not execute with a plan gate'); },
    async executePlan(receivedOrder, receivedPlan) {
      loopCalls += 1;
      handedPlan = receivedPlan;
      if (receivedOrder !== order) throw new Error('order identity drift');
      journal.appendEvent({
        version: 1,
        event_id: '33333333-3333-7333-8333-333333333333',
        order_id: orderId,
        runner_id: runner,
        sequence: 2,
        state: 'started',
        occurred_at: 1200,
        evidence: { code: 'started', summary: 'synthetic', ref: null },
      });
      journal.appendEvent({
        version: 1,
        event_id: '44444444-4444-7444-8444-444444444444',
        order_id: orderId,
        runner_id: runner,
        sequence: 3,
        state: 'completed',
        occurred_at: 1201,
        evidence: { code: 'done', summary: 'synthetic', ref: null },
      });
    },
  };

  const supervisor = new RuntimeSupervisor({
    client,
    journal,
    outbox,
    loop,
    admission: () => admission,
    plan: () => {
      planCalls += 1;
      const value = plan(drift && planCalls === 2 ? 'other-adapter' : 'git-adapter');
      generated.push(value);
      return value;
    },
    now: () => 1200,
    event_id: () => '55555555-5555-7555-8555-555555555555',
  });

  try {
    const result = await supervisor.tick(1);
    return {
      result,
      planCalls,
      loopCalls,
      ackCalls,
      handedIsRevalidatedObject: handedPlan === generated.at(-1),
      handedFingerprint: handedPlan?.fingerprint ?? null,
      expectedFingerprint: generated.at(-1)?.fingerprint ?? null,
      handedAdapter: handedPlan?.adapter_id ?? null,
      events: journal.recover().events.map((event) => event.state),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  match: await scenario(false),
  drift: await scenario(true),
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


class FactoryRunnerPlanAdapterSupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = run_scenarios()

    def test_supervisor_hands_same_plan_fingerprint_and_adapter_id_to_loop(self):
        match = self.observed["match"]
        self.assertEqual(match["result"], {"processed": 1, "cursor": None})
        self.assertEqual(match["planCalls"], 2)
        self.assertEqual(match["loopCalls"], 1)
        self.assertTrue(match["handedIsRevalidatedObject"])
        self.assertEqual(match["handedFingerprint"], match["expectedFingerprint"])
        self.assertEqual(match["handedAdapter"], "git-adapter")
        self.assertEqual(match["events"], ["accepted", "started", "completed"])

    def test_revalidated_plan_adapter_mismatch_blocks_before_adapter_effect(self):
        drift = self.observed["drift"]
        self.assertEqual(drift["result"], {"processed": 0, "cursor": None})
        self.assertEqual(drift["planCalls"], 2)
        self.assertEqual(drift["loopCalls"], 0)
        self.assertEqual(drift["ackCalls"], 0)
        self.assertIsNone(drift["handedFingerprint"])
        self.assertEqual(drift["events"], [])


if __name__ == "__main__":
    unittest.main()
