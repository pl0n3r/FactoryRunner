"""Aceptación del bundle local de auditoría del ExecutionPlan (#125)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { planAuditBundle } from './src/plan-audit.ts';
import { planDoctor } from './src/plan-doctor.ts';
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
  work_item_id: 'factoryrunner:work:125',
  runner_id: runner,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-125',
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
const terminal = {
  version: 1,
  event_id: '33333333-3333-7333-8333-333333333333',
  order_id: order.order_id,
  runner_id: runner,
  sequence: 3,
  state: 'completed',
  occurred_at: 1190,
  evidence: {
    code: 'done',
    summary: 'raw execution detail must not enter audit bundle',
    ref: null,
  },
};
const batch = planEventBatch(order, [terminal], plan);
const heartbeat = {
  version: 1,
  runner_id: runner,
  sequence: 9,
  observed_at: 1195,
  status: 'ready',
  capacity: { max: 2, active: 0 },
  active_sessions: [],
};
const readiness = planReadiness(order, plan, telemetry, batch, heartbeat, now);
const doctor = planDoctor(order, plan, telemetry, readiness);
const bundle = planAuditBundle(order, plan, batch, telemetry, readiness);

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const sensitiveBatchRejected = rejected(() =>
  planAuditBundle(order, plan, { ...batch, token: 'secret-value' }, telemetry, readiness)
);
const mismatchedBatchRejected = rejected(() =>
  planAuditBundle(order, plan, { ...batch, fingerprint: 'f'.repeat(64) }, telemetry, readiness)
);
const mismatchedReadinessRejected = rejected(() =>
  planAuditBundle(
    order,
    plan,
    batch,
    telemetry,
    { ...readiness, batch_fingerprint: 'e'.repeat(64) },
  )
);

console.log(JSON.stringify({
  bundle,
  frozen: Object.isFrozen(bundle),
  serialized: JSON.stringify(bundle),
  planFingerprint: plan.fingerprint,
  batchFingerprint: batch.fingerprint,
  telemetryFingerprint: telemetry.fingerprint,
  readinessFingerprint: readiness.fingerprint,
  doctorFingerprint: doctor.fingerprint,
  sensitiveBatchRejected,
  mismatchedBatchRejected,
  mismatchedReadinessRejected,
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


class FactoryRunnerPlanAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_audit_bundle_links_plan_batch_telemetry_and_readiness_fingerprints(self):
        bundle = self.observed["bundle"]

        self.assertEqual(bundle["version"], 1)
        self.assertEqual(bundle["authority"], "unchanged")
        self.assertEqual(bundle["status"], "AUDIT_READY")
        self.assertEqual(bundle["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(bundle["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(bundle["adapter_id"], "git-adapter")
        self.assertEqual(bundle["plan_fingerprint"], self.observed["planFingerprint"])
        self.assertEqual(bundle["batch_fingerprint"], self.observed["batchFingerprint"])
        self.assertEqual(bundle["telemetry_fingerprint"], self.observed["telemetryFingerprint"])
        self.assertEqual(bundle["readiness_fingerprint"], self.observed["readinessFingerprint"])
        self.assertEqual(bundle["doctor_fingerprint"], self.observed["doctorFingerprint"])
        self.assertRegex(bundle["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"])

        serialized = self.observed["serialized"].lower()
        for forbidden in (
            "instruction_ref",
            "work_item_id",
            "capability",
            "events",
            "evidence",
            "summary",
            "payload",
            "secret",
            "token",
            "credential",
            "http://",
            "https://",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_sensitive_or_mismatched_audit_evidence_fails_closed(self):
        self.assertTrue(self.observed["sensitiveBatchRejected"])
        self.assertTrue(self.observed["mismatchedBatchRejected"])
        self.assertTrue(self.observed["mismatchedReadinessRejected"])


if __name__ == "__main__":
    unittest.main()
