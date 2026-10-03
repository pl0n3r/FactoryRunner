"""Aceptación del health sanitizado del directorio browser remoto (#263)."""
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
    endpoint: `https://example.invalid/${name}`,
    headers: { authorization: 'sentinel-secret' },
    cookies: 'sentinel-cookie',
    async execute() {
      throw new Error('health must not execute transport');
    },
  };
}

const directory = new BrowserRemoteDirectory();
const alpha = profile('browser.navigate', 'browser-alpha');
const beta = profile('browser.close', 'browser-beta');
directory.register({ profile: alpha, transport: transport('alpha') });
directory.register({ profile: beta, transport: transport('beta') });

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
const currentHealth = browserRemoteDirectoryHealth(directory, doctor);
const repeatedHealth = browserRemoteDirectoryHealth(directory, doctor);

directory.rotate(
  'browser-alpha',
  alpha.fingerprint,
  {
    profile: profile('browser.close', 'browser-alpha'),
    transport: transport('alpha-rotated'),
  },
);
const staleHealth = browserRemoteDirectoryHealth(directory, doctor);

const currentSnapshot = browserRemoteDirectorySnapshot(directory);
const currentReadiness = browserRemoteDirectoryReadiness(
  identity,
  heartbeat,
  currentSnapshot,
  NOW,
);
const currentDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  currentSnapshot,
  currentReadiness,
  NOW,
);
const tamperedDoctor = {
  ...currentDoctor,
  fingerprint: '0'.repeat(64),
};
const tamperedHealth = browserRemoteDirectoryHealth(
  directory,
  tamperedDoctor,
);
const invalidHealth = browserRemoteDirectoryHealth(
  directory,
  { version: 1, status: 'DIRECTORY_READY' },
);

const serialized = JSON.stringify(currentHealth);

console.log(JSON.stringify({
  currentHealth,
  repeatedHealth,
  staleHealth,
  tamperedHealth,
  invalidHealth,
  snapshotFingerprint: snapshot.fingerprint,
  currentSnapshotFingerprint: currentSnapshot.fingerprint,
  doctorFingerprint: doctor.fingerprint,
  frozen: Object.isFrozen(currentHealth),
  containsAlpha: serialized.includes('browser-alpha'),
  containsBeta: serialized.includes('browser-beta'),
  containsLocation: serialized.includes('hostinger-shared'),
  containsTransport: serialized.includes('transport'),
  containsEndpoint: serialized.includes('example.invalid'),
  containsHeaders: serialized.includes('authorization'),
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


class FactoryRunnerBrowserRemoteDirectoryHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_health_is_stable_aggregated_and_excludes_alias_transport_and_provider_details(self):
        item = self.observed["currentHealth"]
        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "READY")
        self.assertEqual(item["profiles_total"], 2)
        self.assertEqual(item["capabilities_total"], 2)
        self.assertEqual(item["diagnostics_pass"], 4)
        self.assertEqual(item["diagnostics_blocked"], 0)
        self.assertEqual(
            item["doctor_fingerprint"],
            self.observed["doctorFingerprint"],
        )
        self.assertEqual(
            item["snapshot_fingerprint"],
            self.observed["snapshotFingerprint"],
        )
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeatedHealth"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        for key in (
            "containsAlpha",
            "containsBeta",
            "containsLocation",
            "containsTransport",
            "containsEndpoint",
            "containsHeaders",
            "containsCookie",
            "containsSecret",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])

    def test_invalid_mixed_or_stale_doctor_evidence_fails_closed(self):
        stale = self.observed["staleHealth"]
        self.assertEqual(stale["status"], "UNAVAILABLE")
        self.assertEqual(stale["diagnostics_pass"], 3)
        self.assertEqual(stale["diagnostics_blocked"], 1)
        self.assertEqual(
            stale["doctor_fingerprint"],
            self.observed["doctorFingerprint"],
        )
        self.assertEqual(
            stale["snapshot_fingerprint"],
            self.observed["currentSnapshotFingerprint"],
        )

        for key in ("tamperedHealth", "invalidHealth"):
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertEqual(item["status"], "UNAVAILABLE")
                self.assertEqual(item["diagnostics_pass"], 0)
                self.assertEqual(item["diagnostics_blocked"], 4)
                self.assertIsNone(item["doctor_fingerprint"])
                self.assertEqual(
                    item["snapshot_fingerprint"],
                    self.observed["currentSnapshotFingerprint"],
                )


if __name__ == "__main__":
    unittest.main()
