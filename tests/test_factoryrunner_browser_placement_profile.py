"""Aceptación del perfil canónico de placement browser (#185)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserPlacementProfile } from './src/browser-placement-profile.ts';
import { capabilityManifest } from './src/capability-manifest.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';
import { stableSha256 } from './src/validation.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const otherRunnerId = '22222222-2222-7222-8222-222222222222';
const now = 1000;
const identity = {
  version: 1,
  runner_id: runnerId,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 2,
};
const heartbeat = {
  version: 1,
  runner_id: runnerId,
  sequence: 7,
  observed_at: now,
  status: 'ready',
  capacity: { max: 2, active: 0 },
  active_sessions: [],
};
const queue = {
  version: 1,
  runner_id: runnerId,
  observed_at: now,
  queued_orders: 0,
};
const resource = resourceSnapshot(identity, heartbeat, queue, now, 30);
const manifest = capabilityManifest(identity, [
  { id: 'browser-execution', capabilities: ['browser.navigate'] },
]);

function evidence(hostLocal, remoteCapable, overrides = {}) {
  const core = {
    version: 1,
    runner_id: runnerId,
    observed_at: now,
    manifest,
    host_local_proven: hostLocal,
    remote_capable_proven: remoteCapable,
    ...overrides,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function rejected(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const local = browserPlacementProfile(identity, resource, evidence(true, false), now);
const remote = browserPlacementProfile(identity, resource, evidence(false, true), now);
const unknown = browserPlacementProfile(identity, resource, evidence(false, false), now);

const mixedCore = {
  version: 1,
  runner_id: otherRunnerId,
  observed_at: now,
  manifest,
  host_local_proven: true,
  remote_capable_proven: false,
};
const mixedEvidence = { ...mixedCore, fingerprint: stableSha256(mixedCore) };

const staleRejected = rejected(() =>
  browserPlacementProfile(identity, resource, evidence(true, false), now + 31),
);
const mixedRejected = rejected(() =>
  browserPlacementProfile(identity, resource, mixedEvidence, now),
);
const sensitiveRejected = rejected(() =>
  browserPlacementProfile(
    identity,
    resource,
    { ...evidence(true, false), token: 'secret=do-not-accept' },
    now,
  ),
);
const tamperedFingerprintRejected = rejected(() =>
  browserPlacementProfile(
    identity,
    resource,
    { ...evidence(false, true), fingerprint: '0'.repeat(64) },
    now,
  ),
);

console.log(JSON.stringify({
  local,
  remote,
  unknown,
  frozen: Object.isFrozen(local),
  staleRejected,
  mixedRejected,
  sensitiveRejected,
  tamperedFingerprintRejected,
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


class FactoryRunnerBrowserPlacementProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_profile_derives_local_remote_and_unknown_from_same_runner_evidence(self):
        local = self.observed["local"]
        remote = self.observed["remote"]
        unknown = self.observed["unknown"]

        self.assertEqual(local["status"], "KNOWN")
        self.assertTrue(local["host_local_proven"])
        self.assertFalse(local["remote_capable_proven"])

        self.assertEqual(remote["status"], "KNOWN")
        self.assertFalse(remote["host_local_proven"])
        self.assertTrue(remote["remote_capable_proven"])

        self.assertEqual(unknown["status"], "UNKNOWN")
        self.assertFalse(unknown["host_local_proven"])
        self.assertFalse(unknown["remote_capable_proven"])

        self.assertEqual(local["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(local["authority"], "unchanged")
        self.assertTrue(self.observed["frozen"])
        for key in (
            "identity_fingerprint",
            "resource_fingerprint",
            "manifest_fingerprint",
            "evidence_fingerprint",
            "fingerprint",
        ):
            self.assertRegex(local[key], r"^[0-9a-f]{64}$")

    def test_stale_mixed_or_sensitive_evidence_fails_closed(self):
        self.assertTrue(self.observed["staleRejected"])
        self.assertTrue(self.observed["mixedRejected"])
        self.assertTrue(self.observed["sensitiveRejected"])
        self.assertTrue(self.observed["tamperedFingerprintRejected"])

        serialized = json.dumps(self.observed["local"]).lower()
        for forbidden in (
            "token",
            "password",
            "cookie",
            "authorization",
            "endpoint",
            "provider",
            "http://",
            "https://",
            "wss://",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
