"""Aceptación del binding placement profile ↔ ExecutionPlan exacto (#195)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlacementGuard } from './src/browser-placement-guard.ts';
import { browserPlacementProfile } from './src/browser-placement-profile.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { capabilityManifest } from './src/capability-manifest.ts';
import { orderFingerprint } from './src/order.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';
const NOW = 6100;
const identity = {
  version: 1, runner_id: RUNNER, protocol_version: 1, runtime: 'node',
  runtime_version: '0.1.0', platform: 'linux-arm64',
  location: 'hostinger-shared', capabilities: ['browser.navigate'], max_parallel: 1,
};
const order = {
  version: 1, order_id: ORDER, work_item_id: 'factoryrunner:work:195',
  runner_id: RUNNER, capability: 'browser.navigate', attempt: 1,
  issued_at: 6000, expires_at: 6300, instruction_ref: 'controlbot:instruction:195',
};
const orderHash = orderFingerprint(order);
const heartbeat = {
  version: 1, runner_id: RUNNER, sequence: 1, observed_at: NOW,
  status: 'ready', capacity: { max: 1, active: 0 }, active_sessions: [],
};
const queue = { version: 1, runner_id: RUNNER, observed_at: NOW, queued_orders: 0 };
const resource = resourceSnapshot(identity, heartbeat, queue, NOW, 30);
const manifest = capabilityManifest(identity, [
  { id: 'browser-execution', capabilities: ['browser.navigate'] },
]);

function evidence() {
  const core = {
    version: 1, runner_id: RUNNER, observed_at: NOW, manifest,
    host_local_proven: false, remote_capable_proven: true,
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function profile() {
  return browserPlacementProfile(identity, resource, evidence(), NOW);
}
function admission() {
  const core = {
    version: 1, decision: 'ALLOW', authority: 'unchanged',
    runner_id: RUNNER, order_id: ORDER, work_item_id: order.work_item_id,
    observed_at: NOW, order_fingerprint: orderHash,
    manifest_fingerprint: manifest.fingerprint,
    resource_fingerprint: stableSha256(resource),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function plan(a) {
  const core = {
    version: 1, authority: 'unchanged', runner_id: RUNNER, order_id: ORDER,
    work_item_id: order.work_item_id, capability: order.capability,
    order_fingerprint: orderHash, admission_fingerprint: a.fingerprint,
    adapter_id: 'browser-execution', manifest_fingerprint: a.manifest_fingerprint,
    resource_fingerprint: a.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function request(p) {
  const step = browserPlanStep(order, p, {
    version: 1, adapter_id: 'browser-execution', capability: 'browser.navigate',
    payload: { url: 'https://example.com/placement-195' },
  });
  return browserLoopRequest(order, p, {
    version: 1, browser_kind: 'step', browser: step,
  });
}
function binding() {
  return browserRemoteProfile({
    version: 1, runner_id: RUNNER, location: 'hostinger-shared',
    capability: 'browser.navigate', remote_alias: 'browser-primary',
  });
}
function directory() {
  const value = new BrowserRemoteDirectory();
  value.register({
    profile: binding(),
    transport: { async execute() { throw new Error('transport must not run in guard test'); } },
  });
  return value;
}
function rewriteProfile(input, patch) {
  const { fingerprint: _ignored, ...core } = input;
  const changed = { ...core, ...patch };
  return { ...changed, fingerprint: stableSha256(changed) };
}
function attempt(profileInput, p, req) {
  try {
    const result = browserPlacementGuard(profileInput, directory(), order, p, req);
    return {
      ok: true,
      error: null,
      requestFingerprint: result.request.fingerprint,
      evidence: result.evidence,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      requestFingerprint: null,
      evidence: null,
    };
  }
}

const a = admission();
const p = plan(a);
const req = request(p);
const canonical = profile();
const staleResource = rewriteProfile(canonical, { resource_fingerprint: 'd'.repeat(64) });
const mixedManifest = rewriteProfile(canonical, { manifest_fingerprint: 'e'.repeat(64) });

console.log(JSON.stringify({
  plan: p,
  canonicalProfile: canonical,
  allowed: attempt(canonical, p, req),
  staleResource: attempt(staleResource, p, req),
  mixedManifest: attempt(mixedManifest, p, req),
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


class FactoryRunnerBrowserPlacementPlanBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_profile_must_match_plan_manifest_and_resource_fingerprints(self):
        observed = self.observed
        plan = observed["plan"]
        profile = observed["canonicalProfile"]
        allowed = observed["allowed"]

        self.assertEqual(profile["runner_id"], plan["runner_id"])
        self.assertEqual(profile["manifest_fingerprint"], plan["manifest_fingerprint"])
        self.assertEqual(profile["resource_fingerprint"], plan["resource_fingerprint"])
        self.assertTrue(allowed["ok"])
        self.assertIsNone(allowed["error"])
        self.assertRegex(allowed["evidence"]["fingerprint"], r"^[0-9a-f]{64}$")

        for key in ("staleResource", "mixedManifest"):
            with self.subTest(case=key):
                item = observed[key]
                self.assertFalse(item["ok"])
                self.assertEqual(
                    item["error"],
                    "BrowserPlacementProfile no corresponde al ExecutionPlan.",
                )
                self.assertIsNone(item["requestFingerprint"])
                self.assertIsNone(item["evidence"])

    def test_same_runner_stale_or_mixed_profile_fails_closed(self):
        observed = self.observed
        canonical_runner = observed["canonicalProfile"]["runner_id"]

        self.assertEqual(canonical_runner, observed["plan"]["runner_id"])
        self.assertFalse(observed["staleResource"]["ok"])
        self.assertFalse(observed["mixedManifest"]["ok"])
        self.assertIsNone(observed["staleResource"]["evidence"])
        self.assertIsNone(observed["mixedManifest"]["evidence"])


if __name__ == "__main__":
    unittest.main()
