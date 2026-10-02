"""Aceptación del placement guard obligatorio en BrowserRemoteSupervisor (#196)."""
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
import { browserPlacementProfile } from './src/browser-placement-profile.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { capabilityManifest } from './src/capability-manifest.ts';
import { createBrowserRemoteSupervisor } from './src/browser-remote-supervisor.ts';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';
const NOW = 6200;

const identity = {
  version: 1,
  runner_id: RUNNER,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 1,
};

const order = {
  version: 1,
  order_id: ORDER,
  work_item_id: 'factoryrunner:work:196',
  runner_id: RUNNER,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 6100,
  expires_at: 6500,
  instruction_ref: 'controlbot:instruction:196',
};
const orderHash = orderFingerprint(order);

const heartbeat = {
  version: 1,
  runner_id: RUNNER,
  sequence: 1,
  observed_at: NOW,
  status: 'ready',
  capacity: { max: 1, active: 0 },
  active_sessions: [],
};
const queue = {
  version: 1,
  runner_id: RUNNER,
  observed_at: NOW,
  queued_orders: 0,
};
const resource = resourceSnapshot(identity, heartbeat, queue, NOW, 30);
const manifest = capabilityManifest(identity, [
  { id: 'browser-execution', capabilities: ['browser.navigate'] },
]);

function capabilityEvidence(remoteCapable = true) {
  const core = {
    version: 1,
    runner_id: RUNNER,
    observed_at: NOW,
    manifest,
    host_local_proven: false,
    remote_capable_proven: remoteCapable,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function canonicalProfile() {
  return browserPlacementProfile(identity, resource, capabilityEvidence(true), NOW);
}

function admission() {
  const core = {
    version: 1,
    decision: 'ALLOW',
    authority: 'unchanged',
    runner_id: RUNNER,
    order_id: ORDER,
    work_item_id: order.work_item_id,
    observed_at: NOW,
    order_fingerprint: orderHash,
    manifest_fingerprint: manifest.fingerprint,
    resource_fingerprint: stableSha256(resource),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function plan(a) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER,
    order_id: ORDER,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: orderHash,
    admission_fingerprint: a.fingerprint,
    adapter_id: 'browser-execution',
    manifest_fingerprint: a.manifest_fingerprint,
    resource_fingerprint: a.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function requestFor(p) {
  const step = browserPlanStep(order, p, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: 'https://example.com/placement-196' },
  });
  return browserLoopRequest(order, p, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
}

function rewriteProfile(input, patch) {
  const { fingerprint: _ignored, ...core } = input;
  const changed = { ...core, ...patch };
  return { ...changed, fingerprint: stableSha256(changed) };
}

class FakeTransport {
  calls = 0;
  async execute(request) {
    this.calls += 1;
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:placement-0196',
    };
  }
}

function registry() {
  return new AdapterRegistry([{
    id: 'dummy-adapter',
    capabilities: ['git.head'],
    async execute(capability) {
      return {
        capability,
        data: Object.freeze({ unused: true }),
        evidence: { code: 'unused', summary: 'unused', ref: null },
      };
    },
  }]);
}

function ids() {
  let value = 1;
  return () => `00000000-0000-7000-8000-${String(value++).padStart(12, '0')}`;
}

async function scenario(kind) {
  const root = mkdtempSync(join(tmpdir(), 'factoryrunner-196-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const transport = new FakeTransport();
  const directory = new BrowserRemoteDirectory();
  directory.register({
    profile: browserRemoteProfile({
      version: 1,
      runner_id: RUNNER,
      location: 'hostinger-shared',
      capability: 'browser.navigate',
      remote_alias: 'browser-primary',
    }),
    transport,
  });

  const a = admission();
  const p = plan(a);
  const request = requestFor(p);
  const canonical = canonicalProfile();
  const unknown = rewriteProfile(canonical, {
    host_local_proven: false,
    remote_capable_proven: false,
    status: 'UNKNOWN',
  });
  const mismatch = rewriteProfile(canonical, {
    resource_fingerprint: 'd'.repeat(64),
  });
  const counts = { ack: 0, publish: 0, request: 0, placement: 0 };

  const client = {
    async poll() {
      return {
        version: 1,
        cursor: null,
        orders: [{ ...order, fingerprint: orderHash }],
      };
    },
    validatedOrder(orderId) {
      if (orderId !== ORDER) throw new TypeError('unknown order');
      return order;
    },
    async ack() { counts.ack += 1; },
    async publishEvents() { counts.publish += 1; },
    async publishHeartbeat() {},
  };

  const dependencies = {
    client,
    journal,
    outbox,
    registry: registry(),
    identity,
    directory,
    allowed_origins: ['https://example.com'],
    admission: () => a,
    plan: () => p,
    browser_request: () => {
      counts.request += 1;
      return request;
    },
    now: () => NOW,
    event_id: ids(),
  };

  if (kind !== 'missing') {
    dependencies.placement_profile = () => {
      counts.placement += 1;
      if (kind === 'unknown') return unknown;
      if (kind === 'mismatch') return mismatch;
      return canonical;
    };
  }

  const supervisor = createBrowserRemoteSupervisor(dependencies);
  let result = null;
  let error = null;
  try {
    result = await supervisor.tick(1);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const observed = {
    result,
    error,
    counts,
    transportCalls: transport.calls,
    events: journal.recover().events.map((event) => ({
      state: event.state,
      code: event.evidence.code,
    })),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

console.log(JSON.stringify({
  valid: await scenario('valid'),
  missing: await scenario('missing'),
  unknown: await scenario('unknown'),
  mismatch: await scenario('mismatch'),
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


class FactoryRunnerBrowserRemoteSupervisorPlacementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_requires_guarded_placement_before_browser_request(self):
        valid = self.observed["valid"]
        self.assertEqual(valid["result"], {"processed": 1, "cursor": None})
        self.assertIsNone(valid["error"])
        self.assertEqual(valid["counts"]["placement"], 1)
        self.assertEqual(valid["counts"]["request"], 1)
        self.assertEqual(valid["counts"]["ack"], 1)
        self.assertEqual(valid["transportCalls"], 1)

        missing = self.observed["missing"]
        self.assertIsNotNone(missing["error"])
        self.assertEqual(missing["error"], "Browser runtime request no disponible.")
        self.assertEqual(missing["counts"]["request"], 0)
        self.assertEqual(missing["counts"]["ack"], 0)
        self.assertEqual(missing["transportCalls"], 0)
        self.assertEqual(missing["events"], [])

    def test_unknown_or_mismatched_placement_blocks_before_ack_and_transport(self):
        for key in ("unknown", "mismatch"):
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertIsNotNone(item["error"])
                self.assertEqual(item["counts"]["placement"], 1)
                self.assertEqual(item["counts"]["request"], 1)
                self.assertEqual(item["counts"]["ack"], 0)
                self.assertEqual(item["transportCalls"], 0)
                self.assertEqual(item["events"], [])


if __name__ == "__main__":
    unittest.main()
