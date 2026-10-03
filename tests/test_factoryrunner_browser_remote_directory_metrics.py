"""Aceptación de métricas bounded del health browser remoto (#264)."""
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
const directory = new BrowserRemoteDirectory();
const alpha = profile('browser.navigate', 'browser-alpha');
const beta = profile('browser.close', 'browser-beta');
directory.register({ profile: alpha, transport: { async execute() { return null; } } });
directory.register({ profile: beta, transport: { async execute() { return null; } } });

const snapshot = browserRemoteDirectorySnapshot(directory);
const readiness = browserRemoteDirectoryReadiness(identity, heartbeat, snapshot, NOW);
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
const repeated = browserRemoteDirectoryMetrics(health);

directory.rotate(
  'browser-alpha',
  alpha.fingerprint,
  {
    profile: profile('browser.close', 'browser-alpha'),
    transport: { async execute() { return null; } },
  },
);
const staleHealth = browserRemoteDirectoryHealth(directory, doctor);
const unavailableMetrics = browserRemoteDirectoryMetrics(staleHealth);

function rejected(value) {
  try {
    browserRemoteDirectoryMetrics(value);
    return false;
  } catch {
    return true;
  }
}
const tampered = { ...health, profiles_total: health.profiles_total + 1 };
const overflow = { ...health, profiles_total: 10001 };
const invalid = { version: 1, status: 'READY' };
const serialized = JSON.stringify(metrics);

console.log(JSON.stringify({
  metrics,
  repeated,
  unavailableMetrics,
  tamperedRejected: rejected(tampered),
  overflowRejected: rejected(overflow),
  invalidRejected: rejected(invalid),
  frozen: Object.isFrozen(metrics),
  keys: Object.keys(metrics).sort(),
  containsAlpha: serialized.includes('browser-alpha'),
  containsBeta: serialized.includes('browser-beta'),
  containsLocation: serialized.includes('hostinger-shared'),
  containsProvider: serialized.includes('provider'),
  containsTransport: serialized.includes('transport'),
  containsSecret: serialized.includes('secret'),
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


class FactoryRunnerBrowserRemoteDirectoryMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_metrics_are_fixed_numeric_bounded_and_alias_free(self):
        item = self.observed["metrics"]
        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["readiness"], 1)
        self.assertEqual(item["profiles_total"], 2)
        self.assertEqual(item["capabilities_total"], 2)
        self.assertEqual(item["diagnostics_pass"], 4)
        self.assertEqual(item["diagnostics_blocked"], 0)
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeated"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertEqual(
            self.observed["keys"],
            [
                "authority",
                "capabilities_total",
                "diagnostics_blocked",
                "diagnostics_pass",
                "fingerprint",
                "profiles_total",
                "readiness",
                "version",
            ],
        )
        for field in (
            "readiness",
            "profiles_total",
            "capabilities_total",
            "diagnostics_pass",
            "diagnostics_blocked",
        ):
            with self.subTest(field=field):
                self.assertIsInstance(item[field], int)
                self.assertGreaterEqual(item[field], 0)
        for key in (
            "containsAlpha",
            "containsBeta",
            "containsLocation",
            "containsProvider",
            "containsTransport",
            "containsSecret",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])

        unavailable = self.observed["unavailableMetrics"]
        self.assertEqual(unavailable["readiness"], 0)
        self.assertGreater(unavailable["diagnostics_blocked"], 0)

    def test_tampered_or_invalid_health_is_rejected_fail_closed(self):
        self.assertTrue(self.observed["tamperedRejected"])
        self.assertTrue(self.observed["overflowRejected"])
        self.assertTrue(self.observed["invalidRejected"])


if __name__ == "__main__":
    unittest.main()
