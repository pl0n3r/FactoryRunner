"""Aceptación del doctor local del directorio browser remoto (#258)."""
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
  capacity: { max: 2, active: 1 },
  active_sessions: ['session-1'],
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
      throw new Error('doctor must not execute transport');
    },
  };
}

const directory = new BrowserRemoteDirectory();
const firstProfile = profile('browser.navigate', 'browser-primary');
directory.register({
  profile: firstProfile,
  transport: transport('first'),
});

const firstSnapshot = browserRemoteDirectorySnapshot(directory);
const firstReadiness = browserRemoteDirectoryReadiness(
  identity,
  heartbeat,
  firstSnapshot,
  NOW,
);
const firstDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  firstSnapshot,
  firstReadiness,
  NOW,
);

const secondProfile = profile('browser.close', 'browser-primary');
directory.rotate(
  'browser-primary',
  firstProfile.fingerprint,
  {
    profile: secondProfile,
    transport: transport('second'),
  },
);

const secondSnapshot = browserRemoteDirectorySnapshot(directory);
const secondReadiness = browserRemoteDirectoryReadiness(
  identity,
  heartbeat,
  secondSnapshot,
  NOW,
);

const staleDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  firstSnapshot,
  firstReadiness,
  NOW,
);
const mixedDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  secondSnapshot,
  firstReadiness,
  NOW,
);
const currentDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  secondSnapshot,
  secondReadiness,
  NOW,
);
const repeatedDoctor = browserRemoteDirectoryDoctor(
  identity,
  heartbeat,
  directory,
  secondSnapshot,
  secondReadiness,
  NOW,
);

const serialized = JSON.stringify(currentDoctor);

console.log(JSON.stringify({
  firstDoctor,
  staleDoctor,
  mixedDoctor,
  currentDoctor,
  repeatedDoctor,
  firstSnapshot: firstSnapshot.fingerprint,
  secondSnapshot: secondSnapshot.fingerprint,
  firstReadiness: firstReadiness.fingerprint,
  secondReadiness: secondReadiness.fingerprint,
  frozen: Object.isFrozen(currentDoctor),
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


class FactoryRunnerBrowserRemoteDirectoryDoctorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_doctor_binds_snapshot_and_readiness_fingerprints_without_transport_data(self):
        item = self.observed["currentDoctor"]
        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "DIRECTORY_READY")
        self.assertTrue(item["evidence_current"])
        self.assertEqual(
            item["snapshot_fingerprint"],
            self.observed["secondSnapshot"],
        )
        self.assertEqual(
            item["readiness_fingerprint"],
            self.observed["secondReadiness"],
        )
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeatedDoctor"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertFalse(self.observed["containsTransport"])
        self.assertFalse(self.observed["containsEndpoint"])
        self.assertFalse(self.observed["containsHeaders"])
        self.assertFalse(self.observed["containsCookie"])
        self.assertFalse(self.observed["containsSecret"])

    def test_mixed_or_stale_directory_evidence_is_rejected_fail_closed(self):
        self.assertNotEqual(
            self.observed["firstSnapshot"],
            self.observed["secondSnapshot"],
        )
        self.assertNotEqual(
            self.observed["firstReadiness"],
            self.observed["secondReadiness"],
        )

        for key in ("staleDoctor", "mixedDoctor"):
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertEqual(item["status"], "DIRECTORY_UNAVAILABLE")
                self.assertFalse(item["evidence_current"])
                self.assertEqual(
                    item["snapshot_fingerprint"],
                    self.observed["secondSnapshot"],
                )
                self.assertEqual(
                    item["readiness_fingerprint"],
                    self.observed["secondReadiness"],
                )

        self.assertEqual(
            self.observed["firstDoctor"]["status"],
            "DIRECTORY_READY",
        )
        self.assertNotEqual(
            self.observed["firstDoctor"]["fingerprint"],
            self.observed["currentDoctor"]["fingerprint"],
        )


if __name__ == "__main__":
    unittest.main()
