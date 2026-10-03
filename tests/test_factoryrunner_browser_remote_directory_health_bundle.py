"""Aceptación del bundle health/metrics del directorio browser remoto (#265)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteDirectoryHealthBundle } from './src/browser-remote-directory-health-bundle.ts';
import { browserRemoteDirectoryMetrics } from './src/browser-remote-directory-metrics.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

function doctor(snapshot, readiness, ready) {
  return withFingerprint({
    version: 1,
    authority: 'unchanged',
    status: ready ? 'DIRECTORY_READY' : 'DIRECTORY_UNAVAILABLE',
    runner_id: RUNNER,
    location: 'hostinger-shared',
    snapshot_fingerprint: snapshot,
    readiness_fingerprint: readiness,
    evidence_current: ready,
  });
}

function health(doctorEvidence, profiles, capabilities) {
  const pass =
    2
    + (doctorEvidence.evidence_current ? 1 : 0)
    + (doctorEvidence.status === 'DIRECTORY_READY' ? 1 : 0);
  const blocked = 4 - pass;
  return withFingerprint({
    version: 1,
    authority: 'unchanged',
    status: blocked === 0 ? 'READY' : 'UNAVAILABLE',
    profiles_total: profiles,
    capabilities_total: capabilities,
    diagnostics_pass: pass,
    diagnostics_blocked: blocked,
    doctor_fingerprint: doctorEvidence.fingerprint,
    snapshot_fingerprint: doctorEvidence.snapshot_fingerprint,
  });
}

function evidence(snapshot, readiness, ready, profiles = 2, capabilities = 2) {
  const doctorEvidence = doctor(snapshot, readiness, ready);
  const healthEvidence = health(doctorEvidence, profiles, capabilities);
  const metricsEvidence = browserRemoteDirectoryMetrics(healthEvidence);
  const bundle = browserRemoteDirectoryHealthBundle(
    doctorEvidence,
    healthEvidence,
    metricsEvidence,
  );
  return {
    doctor: doctorEvidence,
    health: healthEvidence,
    metrics: metricsEvidence,
    bundle,
  };
}

function rejected(doctorEvidence, healthEvidence, metricsEvidence) {
  try {
    browserRemoteDirectoryHealthBundle(
      doctorEvidence,
      healthEvidence,
      metricsEvidence,
    );
    return false;
  } catch {
    return true;
  }
}

const first = evidence('a'.repeat(64), 'b'.repeat(64), true);
const repeated = browserRemoteDirectoryHealthBundle(
  first.doctor,
  first.health,
  first.metrics,
);
const second = evidence('c'.repeat(64), 'd'.repeat(64), true, 3, 2);
const unavailable = evidence('e'.repeat(64), 'f'.repeat(64), false, 1, 1);

const tamperedDoctor = { ...second.doctor, fingerprint: '0'.repeat(64) };
const tamperedHealth = { ...second.health, fingerprint: '1'.repeat(64) };
const tamperedMetrics = { ...second.metrics, diagnostics_pass: 3 };
const serialized = JSON.stringify(second.bundle);

console.log(JSON.stringify({
  first,
  repeated,
  second,
  unavailable,
  crossDoctorRejected: rejected(first.doctor, second.health, second.metrics),
  crossMetricsRejected: rejected(second.doctor, second.health, first.metrics),
  tamperedDoctorRejected: rejected(
    tamperedDoctor,
    second.health,
    second.metrics,
  ),
  tamperedHealthRejected: rejected(
    second.doctor,
    tamperedHealth,
    second.metrics,
  ),
  tamperedMetricsRejected: rejected(
    second.doctor,
    second.health,
    tamperedMetrics,
  ),
  frozen: Object.isFrozen(second.bundle),
  containsLocation: serialized.includes('hostinger-shared'),
  containsProvider: serialized.includes('provider'),
  containsTransport: serialized.includes('transport'),
  containsSecret: serialized.includes('secret'),
  containsPayload: serialized.includes('payload'),
}));
"""
    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteDirectoryHealthBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_bundle_binds_doctor_health_and_metrics_fingerprints_without_sensitive_fields(self):
        first = self.observed["first"]
        item = first["bundle"]
        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "READY")
        self.assertEqual(
            item["doctor_fingerprint"],
            first["doctor"]["fingerprint"],
        )
        self.assertEqual(
            item["health_fingerprint"],
            first["health"]["fingerprint"],
        )
        self.assertEqual(
            item["metrics_fingerprint"],
            first["metrics"]["fingerprint"],
        )
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeated"]["fingerprint"],
        )

        second = self.observed["second"]["bundle"]
        self.assertEqual(second["status"], "READY")
        self.assertTrue(self.observed["frozen"])
        unavailable = self.observed["unavailable"]["bundle"]
        self.assertEqual(unavailable["status"], "UNAVAILABLE")

        for key in (
            "containsLocation",
            "containsProvider",
            "containsTransport",
            "containsSecret",
            "containsPayload",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])

    def test_cross_run_or_tampered_evidence_is_rejected_fail_closed(self):
        for key in (
            "crossDoctorRejected",
            "crossMetricsRejected",
            "tamperedDoctorRejected",
            "tamperedHealthRejected",
            "tamperedMetricsRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])


if __name__ == "__main__":
    unittest.main()
