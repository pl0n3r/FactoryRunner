"""Aceptación del outbox ligado al ExecutionPlan en RuntimeSupervisor (#117)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { RuntimeSupervisor } from './src/runtime-supervisor.ts';
import { stableSha256 } from './src/validation.ts';

const runner = '11111111-1111-7111-8111-111111111111';
const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:117',
  runner_id: runner,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-117',
};
const orderHash = orderFingerprint(order);

function signedAdmission() {
  const core = {
    version: 1, decision: 'ALLOW', authority: 'unchanged',
    runner_id: runner, order_id: order.order_id, work_item_id: order.work_item_id,
    observed_at: 1200, order_fingerprint: orderHash,
    manifest_fingerprint: 'b'.repeat(64), resource_fingerprint: 'c'.repeat(64),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function signedPlan(admission, adapterId) {
  const core = {
    version: 1, authority: 'unchanged',
    runner_id: runner, order_id: order.order_id, work_item_id: order.work_item_id,
    capability: order.capability, order_fingerprint: orderHash,
    admission_fingerprint: admission.fingerprint, adapter_id: adapterId,
    manifest_fingerprint: admission.manifest_fingerprint,
    resource_fingerprint: admission.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

async function scenario(kind) {
  const root = mkdtempSync(join(tmpdir(), 'fr-plan-outbox-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const published = [];
  let loopCalls = 0;
  let planCalls = 0;
  let mode = kind === 'drift' ? 'drift' : 'same';
  let latestPlan = null;
  const admission = signedAdmission();

  const client = {
    async poll() {
      return { version: 1, cursor: null, orders: [{ ...order, fingerprint: orderHash }] };
    },
    validatedOrder() { return order; },
    async ack() {},
    async publishEvents(events) { published.push(events.map((event) => event.state)); },
    async publishHeartbeat() {},
  };
  const loop = {
    async execute() { throw new Error('legacy path'); },
    async executePlan(_order, plan) {
      loopCalls += 1;
      latestPlan = plan;
      if (journal.recover().events.at(-1)?.state === 'completed') return;
      journal.appendEvent({
        version: 1, event_id: '33333333-3333-7333-8333-333333333333',
        order_id: order.order_id, runner_id: runner, sequence: 2,
        state: 'started', occurred_at: 1200,
        evidence: { code: 'started', summary: 'synthetic', ref: null },
      });
      journal.appendEvent({
        version: 1, event_id: '44444444-4444-7444-8444-444444444444',
        order_id: order.order_id, runner_id: runner, sequence: 3,
        state: 'completed', occurred_at: 1201,
        evidence: { code: 'done', summary: 'synthetic', ref: null },
      });
    },
  };
  const supervisor = new RuntimeSupervisor({
    client, journal, outbox, loop,
    admission: () => admission,
    plan: () => {
      planCalls += 1;
      const adapter = mode === 'drift' && planCalls % 2 === 0 ? 'other-adapter'
        : mode === 'replay' ? 'other-adapter' : 'git-adapter';
      return signedPlan(admission, adapter);
    },
    now: () => 1200,
    event_id: () => '55555555-5555-7555-8555-555555555555',
  });

  try {
    let first = null;
    let error = null;
    try { first = await supervisor.tick(1); } catch (caught) { error = caught.constructor.name; }

    if (kind === 'replay') {
      mode = 'replay';
      planCalls = 0;
      try { await supervisor.tick(1); } catch (caught) { error = caught.constructor.name; }
    }

    const recovered = outbox.recover();
    const planDeliveries = [...recovered.pending, ...recovered.delivered]
      .filter((delivery) => delivery.kind === 'plan-events');
    return {
      first, error, loopCalls, published,
      latestPlanFingerprint: latestPlan?.fingerprint ?? null,
      planDeliveries: planDeliveries.map((delivery) => ({
        plan_fingerprint: delivery.plan_fingerprint,
        states: delivery.request.events.map((event) => event.state),
      })),
      states: journal.recover().events.map((event) => event.state),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  match: await scenario('match'),
  drift: await scenario('drift'),
  replay: await scenario('replay'),
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


class FactoryRunnerPlanOutboxSupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_enqueues_and_publishes_events_bound_to_revalidated_plan(self):
        match = self.observed["match"]
        self.assertEqual(match["first"], {"processed": 1, "cursor": None})
        self.assertEqual(match["published"], [["completed"]])
        self.assertEqual(len(match["planDeliveries"]), 1)
        delivery = match["planDeliveries"][0]
        self.assertEqual(delivery["plan_fingerprint"], match["latestPlanFingerprint"])
        self.assertEqual(delivery["states"], ["completed"])
        self.assertEqual(match["states"], ["accepted", "started", "completed"])

    def test_plan_mismatch_or_replay_conflict_blocks_before_publish(self):
        drift = self.observed["drift"]
        self.assertEqual(drift["first"], {"processed": 0, "cursor": None})
        self.assertEqual(drift["loopCalls"], 0)
        self.assertEqual(drift["published"], [])
        self.assertEqual(drift["planDeliveries"], [])
        self.assertEqual(drift["states"], [])

        replay = self.observed["replay"]
        self.assertEqual(replay["error"], "DurableOutboxError")
        self.assertEqual(replay["published"], [["completed"]])
        self.assertEqual(len(replay["planDeliveries"]), 1)


if __name__ == "__main__":
    unittest.main()
