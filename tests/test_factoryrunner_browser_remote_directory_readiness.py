"""Aceptación de readiness del directorio browser remoto (#257)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteDirectorySnapshot } from './src/browser-remote-directory-snapshot.ts';
import { browserRemoteDirectoryReadiness } from './src/browser-remote-directory-readiness.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
const NOW = 1_000;

function identity() {
  return {
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
}

function heartbeat(overrides = {}) {
  return {
    version: 1,
    runner_id: RUNNER,
    sequence: 7,
    observed_at: 990,
    status: 'ready',
    capacity: { max: 2, active: 1 },
    active_sessions: ['session-1'],
    ...overrides,
  };
}

function profile(runnerId, location, capability, alias) {
  return browserRemoteProfile({
    version: 1,
    runner_id: runnerId,
    location,
    capability,
    remote_alias: alias,
  });
}

function transport() {
  return {
    endpoint: 'https://example.invalid/private',
    headers: { authorization: 'sentinel-secret' },
    async execute() {
      throw new Error('transport must not run during readiness');
    },
  };
}

function snapshot(entries) {
  const directory = new BrowserRemoteDirectory();
  for (const item of entries) directory.register(item);
  return browserRemoteDirectorySnapshot(directory);
}

const matchingSnapshot = snapshot([
  {
    profile: profile(
      RUNNER,
      'hostinger-shared',
      'browser.navigate',
      'browser-primary',
    ),
    transport: transport(),
  },
  {
    profile: profile(
      RUNNER,
      'other-location',
      'browser.close',
      'browser-other-location',
    ),
    transport: transport(),
  },
  {
    profile: profile(
      OTHER,
      'hostinger-shared',
      'browser.close',
      'browser-other-runner',
    ),
    transport: transport(),
  },
]);

const ready = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat(),
  matchingSnapshot,
  NOW,
);

const stale = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat({ observed_at: 850 }),
  matchingSnapshot,
  NOW,
);
const offline = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat({ status: 'offline' }),
  matchingSnapshot,
  NOW,
);
const draining = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat({ status: 'draining' }),
  matchingSnapshot,
  NOW,
);
const zeroCapacity = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat({
    status: 'busy',
    capacity: { max: 2, active: 2 },
    active_sessions: ['session-1', 'session-2'],
  }),
  matchingSnapshot,
  NOW,
);

const mismatchedSnapshot = snapshot([
  {
    profile: profile(
      OTHER,
      'hostinger-shared',
      'browser.navigate',
      'browser-mismatch',
    ),
    transport: transport(),
  },
]);
const mismatch = browserRemoteDirectoryReadiness(
  identity(),
  heartbeat(),
  mismatchedSnapshot,
  NOW,
);

const serialized = JSON.stringify(ready);

console.log(JSON.stringify({
  ready,
  stale,
  offline,
  draining,
  zeroCapacity,
  mismatch,
  snapshotFingerprint: matchingSnapshot.fingerprint,
  frozen: Object.isFrozen(ready),
  capabilitiesFrozen: Object.isFrozen(ready.capabilities),
  containsTransport: serialized.includes('transport'),
  containsEndpoint: serialized.includes('example.invalid'),
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


class FactoryRunnerBrowserRemoteDirectoryReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_healthy_runner_exposes_only_matching_remote_capabilities_with_snapshot_provenance(self):
        ready = self.observed["ready"]
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(
            ready["runner_id"],
            "11111111-1111-7111-8111-111111111111",
        )
        self.assertEqual(ready["location"], "hostinger-shared")
        self.assertEqual(ready["heartbeat_health"], "healthy")
        self.assertEqual(ready["available_capacity"], 1)
        self.assertEqual(ready["capabilities"], ["browser.navigate"])
        self.assertEqual(
            ready["snapshot_fingerprint"],
            self.observed["snapshotFingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["capabilitiesFrozen"])
        self.assertFalse(self.observed["containsTransport"])
        self.assertFalse(self.observed["containsEndpoint"])
        self.assertFalse(self.observed["containsSecret"])

    def test_stale_offline_draining_zero_capacity_or_mismatch_fail_closed(self):
        for key in (
            "stale",
            "offline",
            "draining",
            "zeroCapacity",
            "mismatch",
        ):
            with self.subTest(case=key):
                result = self.observed[key]
                self.assertEqual(result["status"], "unavailable")
                self.assertEqual(result["available_capacity"], 0)
                self.assertEqual(result["capabilities"], [])
                self.assertEqual(len(result["fingerprint"]), 64)

        self.assertEqual(self.observed["stale"]["heartbeat_health"], "stale")
        self.assertEqual(self.observed["offline"]["heartbeat_health"], "offline")
        self.assertEqual(
            self.observed["draining"]["heartbeat_health"],
            "healthy",
        )


if __name__ == "__main__":
    unittest.main()
