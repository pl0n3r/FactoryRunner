"""Aceptación del bundle health/metrics del directorio browser remoto (#265)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteDirectoryDoctor } from './src/browser-remote-directory-doctor.ts';
import { browserRemoteDirectoryHealth } from './src/browser-remote-directory-health.ts';
import { browserRemoteDirectoryHealthBundle } from './src/browser-remote-directory-health-bundle.ts';
import { browserRemoteDirectoryMetrics } from './src/browser-remote-directory-metrics.ts';
import { browserRemoteDirectorySnapshot } from './src/browser-remote-directory-snapshot.ts';
import { browserRemoteDirectoryReadiness } from './src/browser-remote-directory-readiness.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const NOW = 1_000;
const identity = {
  version: 1,
  runner_id: RUNNER,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '24.0.0',
  platform: 'linux',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate', 'browser.close'],
  max_parallel: 2,
};
const heartbeat = {
  version: 1,
  runner_id: RUNNER,
  sequence: 8,
  observed_at: 995,
  status: 'ready',
  capacity: { max: 2, active: 0 },
  active_sessions: [],
};

function profile(capability, alias) {
  return browserRemoteProfile({
    version: 1,
    runner_id: RUNNER,
    location: 'hostinger-shared',
    capability,
    remote_alias: alias,
  });
}

function transport(name) {
  return {
    endpoint: `https://provider.example.invalid/${name}`,
    headers: { authorization: 'sentinel-secret' },
    cookies: 'sentinel-cookie',
    async execute() {
      throw new Error('bundle must not execute transport');
    },
  };
}

function currentEvidence(directory) {
  const snapshot = browserRemoteDirectorySnapshot(directory);
  const readiness = browserRemoteDirectoryReadiness(
    identity,
    heartbeat,
    snapshot,
    NOW,
  );
  const doctor = browserRemoteDirectoryDoctor(
    identity,
    heartbeat,
    directory,
    snapshot,
    readiness,
    NOW,
  );
  const health = browserRemoteDirectoryHealth(directory, doctor);
  const metrics = browserRemoteDirectoryMetrics(health);
  return { snapshot, readiness, doctor, health, metrics };
}

function rejected(...args) {
  try {
    browserRemoteDirectoryHealthBundle(...args);
    return false;
  } catch {
    return true;
  }
}

const directory = new BrowserRemoteDirectory();
const alpha = profile('browser.navigate', 'browser-alpha');
const beta = profile('browser.close', 'browser-beta');
directory.register({ profile: alpha, transport: transport('alpha') });
directory.register({ profile: beta, transport: transport('beta') });

const first = currentEvidence(directory);
const readyBundle = browserRemoteDirectoryHealthBundle(
  first.doctor,
  first.health,
  first.metrics,
);
const repeatedBundle = browserRemoteDirectoryHealthBundle(
  first.doctor,
  first.health,
  first.metrics,
);

directory.rotate(
  'browser-alpha',
  alpha.fingerprint,
  {
    profile: profile('browser.close', 'browser-alpha'),
    transport: transport('rotated'),
  },
);

const staleDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  first.snapshot,
  first.readiness,
  NOW,
);
const staleHealth = browserRemoteDirectoryHealth(directory, staleDoctor);
const staleMetrics = browserRemoteDirectoryMetrics(staleHealth);
const unavailableBundle = browserRemoteDirectoryHealthBundle(
  staleDoctor,
  staleHealth,
  staleMetrics,
);

const second = currentEvidence(directory);
const currentBundle = browserRemoteDirectoryHealthBundle(
  second.doctor,
  second.health,
  second.metrics,
);

const tamperedDoctor = {
  ...second.doctor,
  fingerprint: '0'.repeat(64),
};
const tamperedHealth = {
  ...second.health,
  snapshot_fingerprint: first.snapshot.fingerprint,
};
const tamperedMetrics = {
  ...second.metrics,
  diagnostics_pass: second.metrics.diagnostics_pass - 1,
};

const serialized = JSON.stringify(currentBundle);

console.log(JSON.stringify({
  readyBundle,
  repeatedBundle,
  unavailableBundle,
  currentBundle,
  firstDoctor: first.doctor.fingerprint,
  firstHealth: first.health.fingerprint,
  firstMetrics: first.metrics.fingerprint,
  secondDoctor: second.doctor.fingerprint,
  secondHealth: second.health.fingerprint,
  secondMetrics: second.metrics.fingerprint,
  crossDoctorRejected: rejected(
    first.doctor,
    second.health,
    second.metrics,
  ),
  crossMetricsRejected: rejected(
    second.doctor,
    second.health,
    first.metrics,
  ),
  staleCrossRejected: rejected(
    first.doctor,
    staleHealth,
    staleMetrics,
  ),
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
  frozen: Object.isFrozen(currentBundle),
  containsAlpha: serialized.includes('browser-alpha'),
  containsBeta: serialized.includes('browser-beta'),
  containsLocation: serialized.includes('hostinger-shared'),
  containsProvider: serialized.includes('provider.example.invalid'),
  containsTransport: serialized.includes('transport'),
  containsAuthorization: serialized.includes('authorization'),
  containsCookie: serialized.includes('sentinel-cookie'),
  containsSecret: serialized.includes('sentinel-secret'),
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
        item = self.observed["readyBundle"]
        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "READY")
        self.assertEqual(
            item["doctor_fingerprint"],
            self.observed["firstDoctor"],
        )
        self.assertEqual(
            item["health_fingerprint"],
            self.observed["firstHealth"],
        )
        self.assertEqual(
            item["metrics_fingerprint"],
            self.observed["firstMetrics"],
        )
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeatedBundle"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])

        current = self.observed["currentBundle"]
        self.assertEqual(current["status"], "READY")
        self.assertEqual(
            current["doctor_fingerprint"],
            self.observed["secondDoctor"],
        )
        self.assertEqual(
            current["health_fingerprint"],
            self.observed["secondHealth"],
        )
        self.assertEqual(
            current["metrics_fingerprint"],
            self.observed["secondMetrics"],
        )

        unavailable = self.observed["unavailableBundle"]
        self.assertEqual(unavailable["status"], "UNAVAILABLE")
        self.assertFalse(unavailable["network_access"])
        self.assertFalse(unavailable["external_mutation"])

        for key in (
            "containsAlpha",
            "containsBeta",
            "containsLocation",
            "containsProvider",
            "containsTransport",
            "containsAuthorization",
            "containsCookie",
            "containsSecret",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])

    def test_cross_run_or_tampered_evidence_is_rejected_fail_closed(self):
        for key in (
            "crossDoctorRejected",
            "crossMetricsRejected",
            "staleCrossRejected",
            "tamperedDoctorRejected",
            "tamperedHealthRejected",
            "tamperedMetricsRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])


if __name__ == "__main__":
    unittest.main()
