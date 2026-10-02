"""Aceptación de pin browser remoto frente a drift durante ACK (#204)."""
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
const NOW = 8200;

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
  work_item_id: 'factoryrunner:work:204',
  runner_id: RUNNER,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 8100,
  expires_at: 8600,
  instruction_ref: 'controlbot:instruction:204',
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

function capabilityEvidence() {
  const core = {
    version: 1,
    runner_id: RUNNER,
    observed_at: NOW,
    manifest,
    host_local_proven: false,
    remote_capable_proven: true,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function placementProfile() {
  return browserPlacementProfile(identity, resource, capabilityEvidence(), NOW);
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
    payload: { url: 'https://example.com/ack-drift-204' },
  });
  return browserLoopRequest(order, p, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
}

function remoteProfile(alias) {
  return browserRemoteProfile({
    version: 1,
    runner_id: RUNNER,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: alias,
  });
}

class Transport {
  calls = 0;
  requests = [];

  constructor(name) {
    this.name = name;
  }

  async execute(request) {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:ack-drift-0204',
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

function ids(seed) {
  let value = seed;
  return () => `00000000-0000-7000-8000-${String(value++).padStart(12, '0')}`;
}

function configuredSupervisor(root, directory, counts, onAck, seed) {
  const a = admission();
  const p = plan(a);
  const request = requestFor(p);
  return createBrowserRemoteSupervisor({
    client: {
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
      async ack() {
        counts.ack += 1;
        await onAck();
      },
      async publishEvents() { counts.publish += 1; },
      async publishHeartbeat() {},
    },
    journal: new DurableJournal(join(root, 'journal.ndjson')),
    outbox: new DurableOutbox(join(root, 'outbox.ndjson')),
    registry: registry(),
    identity,
    directory,
    allowed_origins: ['https://example.com'],
    admission: () => a,
    plan: () => p,
    placement_profile: () => {
      counts.placement += 1;
      return placementProfile();
    },
    browser_request: () => {
      counts.request += 1;
      return request;
    },
    now: () => NOW,
    event_id: ids(seed),
  });
}

async function driftDuringAck() {
  const root = mkdtempSync(join(tmpdir(), 'fr204-ack-drift-'));
  const primary = new Transport('primary');
  const secondary = new Transport('secondary');
  const directory = new BrowserRemoteDirectory();
  const primaryProfile = remoteProfile('browser-primary');
  const secondaryProfile = remoteProfile('browser-secondary');
  directory.register({ profile: primaryProfile, transport: primary });

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {
      directory.register({ profile: secondaryProfile, transport: secondary });
    },
    1,
  );

  const result = await runtime.tick(1);
  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    result,
    counts,
    primaryCalls: primary.calls,
    secondaryCalls: secondary.calls,
    selectedProfile: primary.requests[0]?.profile_fingerprint ?? null,
    expectedProfile: primaryProfile.fingerprint,
    events: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function expectedBindingMissingDuringAck() {
  const root = mkdtempSync(join(tmpdir(), 'fr204-binding-missing-'));
  const primary = new Transport('primary');
  const secondary = new Transport('secondary');
  const directory = new BrowserRemoteDirectory();
  directory.register({ profile: remoteProfile('browser-primary'), transport: primary });

  const replacement = new BrowserRemoteDirectory();
  replacement.register({ profile: remoteProfile('browser-secondary'), transport: secondary });

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {
      directory.entries = () => replacement.entries();
    },
    20,
  );

  let error = null;
  try {
    await runtime.tick(1);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    error,
    counts,
    primaryCalls: primary.calls,
    secondaryCalls: secondary.calls,
    events: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function recovery() {
  const root = mkdtempSync(join(tmpdir(), 'fr204-recovery-'));
  const firstTransport = new Transport('first');
  const firstDirectory = new BrowserRemoteDirectory();
  firstDirectory.register({
    profile: remoteProfile('browser-primary'),
    transport: firstTransport,
  });
  const firstCounts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const first = configuredSupervisor(root, firstDirectory, firstCounts, async () => {}, 40);
  const firstResult = await first.tick(1);

  const restartTransport = new Transport('restart');
  const restartDirectory = new BrowserRemoteDirectory();
  restartDirectory.register({
    profile: remoteProfile('browser-primary'),
    transport: restartTransport,
  });
  const restartCounts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const restart = configuredSupervisor(
    root,
    restartDirectory,
    restartCounts,
    async () => {},
    100,
  );
  const restartResult = await restart.tick(1);

  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    firstResult,
    restartResult,
    firstCounts,
    restartCounts,
    firstTransportCalls: firstTransport.calls,
    restartTransportCalls: restartTransport.calls,
    events: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

console.log(JSON.stringify({
  drift: await driftDuringAck(),
  missing: await expectedBindingMissingDuringAck(),
  recovery: await recovery(),
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


class FactoryRunnerBrowserRemoteAckDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_directory_drift_during_ack_never_switches_remote_binding_or_transport(self):
        drift = self.observed["drift"]
        self.assertEqual(drift["result"], {"processed": 1, "cursor": None})
        self.assertEqual(drift["counts"]["ack"], 1)
        self.assertEqual(drift["primaryCalls"], 1)
        self.assertEqual(drift["secondaryCalls"], 0)
        self.assertEqual(drift["selectedProfile"], drift["expectedProfile"])
        self.assertEqual(drift["events"], ["accepted", "started", "completed"])

        missing = self.observed["missing"]
        self.assertIsNotNone(missing["error"])
        self.assertEqual(missing["counts"]["ack"], 1)
        self.assertEqual(missing["primaryCalls"], 0)
        self.assertEqual(missing["secondaryCalls"], 0)
        self.assertEqual(missing["events"], ["accepted"])

    def test_recovery_revalidates_pinned_binding_without_ack_or_transport_replay(self):
        recovery = self.observed["recovery"]
        self.assertEqual(recovery["firstResult"], {"processed": 1, "cursor": None})
        self.assertEqual(recovery["firstCounts"]["placement"], 1)
        self.assertEqual(recovery["firstCounts"]["request"], 1)
        self.assertEqual(recovery["firstCounts"]["ack"], 1)
        self.assertEqual(recovery["firstTransportCalls"], 1)

        self.assertEqual(recovery["restartResult"], {"processed": 1, "cursor": None})
        self.assertEqual(recovery["restartCounts"]["placement"], 1)
        self.assertEqual(recovery["restartCounts"]["request"], 1)
        self.assertEqual(recovery["restartCounts"]["ack"], 0)
        self.assertEqual(recovery["restartCounts"]["publish"], 0)
        self.assertEqual(recovery["restartTransportCalls"], 0)
        self.assertEqual(recovery["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
