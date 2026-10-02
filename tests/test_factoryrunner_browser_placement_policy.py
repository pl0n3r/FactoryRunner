"""Aceptación de la política fail-closed de placement browser (#186)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserPlacementProfile } from './src/browser-placement-profile.ts';
import { browserPlacementPolicy } from './src/browser-placement-policy.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
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

function evidence(hostLocal, remoteCapable) {
  const core = {
    version: 1,
    runner_id: runnerId,
    observed_at: now,
    manifest,
    host_local_proven: hostLocal,
    remote_capable_proven: remoteCapable,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function profile(hostLocal, remoteCapable) {
  return browserPlacementProfile(
    identity,
    resource,
    evidence(hostLocal, remoteCapable),
    now,
  );
}

const exactBinding = browserRemoteProfile({
  version: 1,
  runner_id: runnerId,
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});
const secondBinding = browserRemoteProfile({
  version: 1,
  runner_id: runnerId,
  location: 'hostinger-shared',
  capability: 'browser.click_ref',
  remote_alias: 'browser-secondary',
});
const foreignBinding = browserRemoteProfile({
  version: 1,
  runner_id: otherRunnerId,
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-foreign',
});

const local = browserPlacementPolicy(profile(true, true), [exactBinding, secondBinding]);
const remote = browserPlacementPolicy(profile(false, true), [exactBinding]);
const unknown = browserPlacementPolicy(profile(false, false), [exactBinding]);
const missingBinding = browserPlacementPolicy(profile(false, true), []);
const ambiguousBinding = browserPlacementPolicy(
  profile(false, true),
  [exactBinding, secondBinding],
);
const foreignOnly = browserPlacementPolicy(profile(false, true), [foreignBinding]);

console.log(JSON.stringify({
  local,
  remote,
  unknown,
  missingBinding,
  ambiguousBinding,
  foreignOnly,
  frozen: Object.isFrozen(remote),
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


class FactoryRunnerBrowserPlacementPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_policy_prefers_proven_local_else_exact_remote_binding_without_provider_selection(self):
        local = self.observed["local"]
        remote = self.observed["remote"]

        self.assertEqual(local["placement"], "HOST_LOCAL")
        self.assertEqual(local["reason"], "LOCAL_CAPACITY_PROVEN")
        self.assertIsNone(local["binding_fingerprint"])

        self.assertEqual(remote["placement"], "REMOTE_BINDING")
        self.assertEqual(remote["reason"], "EXACT_REMOTE_BINDING")
        self.assertRegex(remote["binding_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(remote["profile_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(remote["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"])

        serialized = json.dumps(remote).lower()
        for forbidden in (
            "remote_alias",
            "provider",
            "endpoint",
            "hostname",
            "token",
            "password",
            "cookie",
            "authorization",
            "http://",
            "https://",
            "wss://",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

    def test_unknown_or_ambiguous_capacity_blocks_without_silent_fallback(self):
        for key in ("unknown", "missingBinding", "ambiguousBinding", "foreignOnly"):
            with self.subTest(case=key):
                decision = self.observed[key]
                self.assertEqual(decision["placement"], "BLOCKED_UNKNOWN")
                self.assertIsNone(decision["binding_fingerprint"])

        self.assertEqual(self.observed["unknown"]["reason"], "UNKNOWN_CAPACITY")
        for key in ("missingBinding", "ambiguousBinding", "foreignOnly"):
            self.assertEqual(
                self.observed[key]["reason"],
                "REMOTE_BINDING_NOT_EXACT",
            )

        serialized = json.dumps(
            {
                "missing": self.observed["missingBinding"],
                "ambiguous": self.observed["ambiguousBinding"],
                "foreign": self.observed["foreignOnly"],
            }
        ).lower()
        self.assertNotIn("macos", serialized)
        self.assertNotIn("fallback", serialized)


if __name__ == "__main__":
    unittest.main()
