"""Aceptación del placement guard antes del transport browser (#188)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from './src/adapters/programmatic.ts';
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlacementGuard } from './src/browser-placement-guard.ts';
import { browserPlacementProfile } from './src/browser-placement-profile.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { createBrowserRemoteSupervisor } from './src/browser-remote-supervisor.ts';
import { capabilityManifest } from './src/capability-manifest.ts';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';
const NOW = 5100;
const identity = {
  version: 1, runner_id: RUNNER, protocol_version: 1, runtime: 'node',
  runtime_version: '0.1.0', platform: 'linux-arm64',
  location: 'hostinger-shared', capabilities: ['browser.navigate'], max_parallel: 1,
};
const order = {
  version: 1, order_id: ORDER, work_item_id: 'factoryrunner:work:188',
  runner_id: RUNNER, capability: 'browser.navigate', attempt: 1,
  issued_at: 5000, expires_at: 5300, instruction_ref: 'controlbot:instruction:188',
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

function evidence(hostLocal, remoteCapable) {
  const core = {
    version: 1, runner_id: RUNNER, observed_at: NOW, manifest,
    host_local_proven: hostLocal, remote_capable_proven: remoteCapable,
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function placement(hostLocal, remoteCapable) {
  return browserPlacementProfile(identity, resource, evidence(hostLocal, remoteCapable), NOW);
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
    payload: { url: 'https://example.com/placement-188' },
  });
  return browserLoopRequest(order, p, {
    version: 1, browser_kind: 'step', browser: step,
  });
}
function registry() {
  return new AdapterRegistry([{
    id: 'dummy-adapter', capabilities: ['git.head'],
    async execute(capability) {
      return { capability, data: Object.freeze({ unused: true }),
        evidence: { code: 'unused', summary: 'unused', ref: null } };
    },
  }]);
}
function ids() {
  let n = 1;
  return () => '99999999-9999-7999-8999-' + String(n++).padStart(12, '0');
}
class Transport {
  constructor() { this.calls = 0; this.requests = []; }
  async execute(req) {
    this.calls += 1; this.requests.push(structuredClone(req));
    return {
      version: 1, authority: 'unchanged',
      request_fingerprint: req.request_fingerprint, status: 'ok',
      ref: 'browserref:placement-0188',
    };
  }
}
function remote(capability = 'browser.navigate') {
  return browserRemoteProfile({
    version: 1, runner_id: RUNNER, location: 'hostinger-shared',
    capability, remote_alias: 'browser-primary',
  });
}
async function scenario(kind) {
  const root = mkdtempSync(join(tmpdir(), 'fr188-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const transport = new Transport();
  const directory = new BrowserRemoteDirectory();
  const binding = remote(kind === 'drift' ? 'browser.click_ref' : 'browser.navigate');
  directory.register({ profile: binding, transport });

  const a = admission(); const p = plan(a); const req = request(p);
  const profile = kind === 'unknown' ? placement(false, false)
    : kind === 'local' ? placement(true, true)
    : placement(false, true);
  const counts = { ack: 0, publish: 0 };
  let guardEvidence = null;
  const supervisor = createBrowserRemoteSupervisor({
    client: {
      async poll() { return { version: 1, cursor: null, orders: [{ ...order, fingerprint: orderHash }] }; },
      validatedOrder(id) { if (id !== ORDER) throw new TypeError('unknown'); return order; },
      async ack() { counts.ack += 1; },
      async publishEvents() { counts.publish += 1; },
      async publishHeartbeat() {},
    },
    journal, outbox, registry: registry(), identity, directory,
    allowed_origins: ['https://example.com'],
    admission: () => a, plan: () => p,
    placement_profile: () => profile,
    browser_request: () => {
      const guarded = browserPlacementGuard(profile, directory, order, p, req);
      guardEvidence = guarded.evidence;
      return guarded.request;
    },
    now: () => NOW, event_id: ids(),
  });

  let result = null; let error = null;
  try { result = await supervisor.tick(1); }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }

  const observed = {
    result, error, counts, transportCalls: transport.calls,
    transportRequest: transport.requests[0] ?? null,
    guardEvidence,
    orderFingerprint: orderHash,
    planFingerprint: p.fingerprint,
    requestFingerprint: req.fingerprint,
    bindingFingerprint: binding.fingerprint,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

console.log(JSON.stringify({
  allowed: await scenario('allowed'),
  unknown: await scenario('unknown'),
  local: await scenario('local'),
  drift: await scenario('drift'),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT, text=True, stderr=subprocess.STDOUT, timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserPlacementGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_blocks_before_transport_when_placement_is_not_allowed(self):
        for key in ("unknown", "local", "drift"):
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertIsNotNone(item["error"])
                self.assertEqual(item["transportCalls"], 0)
                self.assertEqual(item["counts"], {"ack": 0, "publish": 0})
                self.assertIsNone(item["guardEvidence"])

    def test_allowed_remote_placement_preserves_plan_request_and_binding_fingerprints(self):
        item = self.observed["allowed"]
        self.assertEqual(item["result"], {"processed": 1, "cursor": None})
        self.assertIsNone(item["error"])
        self.assertEqual(item["transportCalls"], 1)
        self.assertEqual(item["counts"], {"ack": 1, "publish": 1})

        evidence = item["guardEvidence"]
        self.assertEqual(evidence["order_fingerprint"], item["orderFingerprint"])
        self.assertEqual(evidence["plan_fingerprint"], item["planFingerprint"])
        self.assertEqual(evidence["request_fingerprint"], item["requestFingerprint"])
        self.assertEqual(evidence["binding_fingerprint"], item["bindingFingerprint"])
        self.assertRegex(evidence["placement_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(evidence["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            item["transportRequest"]["profile_fingerprint"],
            item["bindingFingerprint"],
        )


if __name__ == "__main__":
    unittest.main()
