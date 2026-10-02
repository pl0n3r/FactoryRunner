"""Aceptación del doctor offline de la cadena ExecutionPlan (#124)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
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
  work_item_id: 'factoryrunner:work:124',
  runner_id: runner,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-124',
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
  evidence: { code: 'done', summary: 'synthetic', ref: null },
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
const report = planDoctor(order, plan, telemetry, readiness);

const rejected = (action) => {
  try {
    action();
    return false;
  } catch {
    return true;
  }
};

const missingProvenance = { ...telemetry };
delete missingProvenance.fingerprint;

const missingProvenanceRejected = rejected(() =>
  planDoctor(order, plan, missingProvenance, readiness)
);
const conflictingAdapterRejected = rejected(() =>
  planDoctor(order, plan, telemetry, { ...readiness, adapter_id: 'other-adapter' })
);
const sensitiveFieldRejected = rejected(() =>
  planDoctor(order, plan, { ...telemetry, token: 'secret-value' }, readiness)
);
const conflictingFingerprintRejected = rejected(() =>
  planDoctor(order, plan, telemetry, { ...readiness, fingerprint: 'f'.repeat(64) })
);

console.log(JSON.stringify({
  report,
  frozen: Object.isFrozen(report),
  serialized: JSON.stringify(report),
  readinessFingerprint: readiness.fingerprint,
  telemetryFingerprint: telemetry.fingerprint,
  missingProvenanceRejected,
  conflictingAdapterRejected,
  sensitiveFieldRejected,
  conflictingFingerprintRejected,
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


class FactoryRunnerPlanDoctorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_doctor_validates_plan_readiness_chain_without_network_or_sensitive_material(self):
        report = self.observed["report"]
        self.assertEqual(report["version"], 1)
        self.assertEqual(report["authority"], "unchanged")
        self.assertEqual(report["status"], "OK")
        self.assertEqual(report["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(report["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(report["adapter_id"], "git-adapter")
        self.assertEqual(report["telemetry_fingerprint"], self.observed["telemetryFingerprint"])
        self.assertEqual(report["readiness_fingerprint"], self.observed["readinessFingerprint"])
        self.assertRegex(report["plan_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(report["fingerprint"], r"^[0-9a-f]{64}$")
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
            "http://",
            "https://",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_missing_or_conflicting_plan_provenance_blocks_deterministically(self):
        self.assertTrue(self.observed["missingProvenanceRejected"])
        self.assertTrue(self.observed["conflictingAdapterRejected"])
        self.assertTrue(self.observed["sensitiveFieldRejected"])
        self.assertTrue(self.observed["conflictingFingerprintRejected"])


if __name__ == "__main__":
    unittest.main()
