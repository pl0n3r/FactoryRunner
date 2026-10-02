"""Aceptación del readiness plan-bound de FactoryRunner (#123)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { planEventBatch } from './src/plan-event-batch.ts';
import { planReadiness } from './src/plan-readiness.ts';
import { planTelemetry } from './src/plan-telemetry.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const now = 1200;
const runner = '11111111-1111-7111-8111-111111111111';
const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:123',
  runner_id: runner,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-123',
};
const planCore = {
  version: 1,
  authority: 'unchanged',
  runner_id: runner,
  order_id: order.order_id,
  work_item_id: order.work_item_id,
  capability: order.capability,
  order_fingerprint: orderFingerprint(order),
  admission_fingerprint: 'a'.repeat(64),
  adapter_id: 'git-adapter',
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };
const telemetry = planTelemetry(order, plan, 'git-adapter');

function terminal(occurredAt = 1190) {
  return {
    version: 1,
    event_id: '33333333-3333-7333-8333-333333333333',
    order_id: order.order_id,
    runner_id: runner,
    sequence: 3,
    state: 'completed',
    occurred_at: occurredAt,
    evidence: {
      code: 'done',
      summary: 'contains raw execution detail that readiness must not copy',
      ref: null,
    },
  };
}

function heartbeat(observedAt = 1195, status = 'ready') {
  return {
    version: 1,
    runner_id: runner,
    sequence: 9,
    observed_at: observedAt,
    status,
    capacity: { max: 2, active: 0 },
    active_sessions: [],
  };
}

const batch = planEventBatch(order, [terminal()], plan);
const readiness = planReadiness(
  order,
  plan,
  telemetry,
  batch,
  heartbeat(),
  now,
);

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const adapterDriftRejected = rejected(() => planReadiness(
  order,
  plan,
  { ...telemetry, adapter_id: 'other-adapter' },
  batch,
  heartbeat(),
  now,
));
const planDriftRejected = rejected(() => planReadiness(
  order,
  { ...plan, adapter_id: 'other-adapter' },
  telemetry,
  batch,
  heartbeat(),
  now,
));
const staleTerminalBatch = planEventBatch(order, [terminal(800)], plan);
const staleTerminalRejected = rejected(() => planReadiness(
  order,
  plan,
  telemetry,
  staleTerminalBatch,
  heartbeat(),
  now,
  300,
));
const staleHeartbeatRejected = rejected(() => planReadiness(
  order,
  plan,
  telemetry,
  batch,
  heartbeat(1000),
  now,
));

console.log(JSON.stringify({
  readiness,
  frozen: Object.isFrozen(readiness),
  serialized: JSON.stringify(readiness),
  telemetry,
  batchFingerprint: batch.fingerprint,
  adapterDriftRejected,
  planDriftRejected,
  staleTerminalRejected,
  staleHeartbeatRejected,
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


class FactoryRunnerPlanReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_plan_readiness_links_plan_telemetry_runtime_and_terminal_evidence(self):
        readiness = self.observed["readiness"]
        telemetry = self.observed["telemetry"]

        self.assertEqual(readiness["version"], 1)
        self.assertEqual(readiness["authority"], "unchanged")
        self.assertEqual(readiness["status"], "READY")
        self.assertEqual(readiness["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(readiness["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(readiness["plan_fingerprint"], telemetry["plan_fingerprint"])
        self.assertEqual(readiness["adapter_id"], "git-adapter")
        self.assertEqual(readiness["telemetry_fingerprint"], telemetry["fingerprint"])
        self.assertEqual(readiness["batch_fingerprint"], self.observed["batchFingerprint"])
        self.assertEqual(readiness["runner_status"], "ready")
        self.assertEqual(readiness["terminal_occurred_at"], 1190)
        self.assertEqual(readiness["heartbeat_observed_at"], 1195)
        self.assertRegex(readiness["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"])

        serialized = self.observed["serialized"].lower()
        for forbidden in (
            "instruction_ref",
            "work_item_id",
            "capability",
            "evidence",
            "summary",
            "payload",
            "secret",
            "token",
            "credential",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_plan_or_adapter_drift_and_stale_evidence_fail_closed(self):
        self.assertTrue(self.observed["adapterDriftRejected"])
        self.assertTrue(self.observed["planDriftRejected"])
        self.assertTrue(self.observed["staleTerminalRejected"])
        self.assertTrue(self.observed["staleHeartbeatRejected"])


if __name__ == "__main__":
    unittest.main()
