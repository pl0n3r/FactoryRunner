"""Aceptación de drift/recovery del placement browser en RuntimeSupervisor (#197)."""
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
const NOW = 7200;

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
  work_item_id: 'factoryrunner:work:197',
  runner_id: RUNNER,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 7100,
  expires_at: 7600,
  instruction_ref: 'controlbot:instruction:197',
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

function canonicalProfile() {
  return browserPlacementProfile(identity, resource, capabilityEvidence(), NOW);
}

function rewriteProfile(input, patch) {
  const { fingerprint: _ignored, ...core } = input;
  const changed = { ...core, ...patch };
  return { ...changed, fingerprint: stableSha256(changed) };
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
    payload: { url: 'https://example.com/runtime-drift-197' },
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

  async execute(request) {
    this.calls += 1;
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:runtime-drift-0197',
    };
  }
}

function directoryWith(transport, alias = 'browser-primary') {
  const directory = new BrowserRemoteDirectory();
  directory.register({ profile: remoteProfile(alias), transport });
  return directory;
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

function client(counts) {
  return {
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
}

function supervisor(root, directory, counts, placementResolver, seed) {
  const a = admission();
  const p = plan(a);
  const request = requestFor(p);
  return createBrowserRemoteSupervisor({
    client: client(counts),
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
      return placementResolver();
    },
    browser_request: () => {
      counts.request += 1;
      return request;
    },
    now: () => NOW,
    event_id: ids(seed),
  });
}

async function profileDrift() {
  const root = mkdtempSync(join(tmpdir(), 'fr197-profile-'));
  const transport = new Transport();
  const directory = directoryWith(transport);
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const canonical = canonicalProfile();
  const drifted = rewriteProfile(canonical, {
    resource_fingerprint: 'd'.repeat(64),
  });
  let calls = 0;
  const runtime = supervisor(
    root,
    directory,
    counts,
    () => (++calls === 1 ? canonical : drifted),
    1,
  );

  const first = await runtime.tick(1);
  let secondError = null;
  try {
    await runtime.tick(1);
  } catch (caught) {
    secondError = caught instanceof Error ? caught.message : String(caught);
  }

  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    first,
    secondError,
    counts,
    transportCalls: transport.calls,
    eventStates: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function bindingDrift() {
  const root = mkdtempSync(join(tmpdir(), 'fr197-binding-'));
  const primary = new Transport();
  const secondary = new Transport();
  const directory = directoryWith(primary);
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = supervisor(root, directory, counts, canonicalProfile, 20);

  const first = await runtime.tick(1);
  directory.register({
    profile: remoteProfile('browser-secondary'),
    transport: secondary,
  });

  let secondError = null;
  try {
    await runtime.tick(1);
  } catch (caught) {
    secondError = caught instanceof Error ? caught.message : String(caught);
  }

  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    first,
    secondError,
    counts,
    primaryCalls: primary.calls,
    secondaryCalls: secondary.calls,
    eventStates: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function recovery() {
  const root = mkdtempSync(join(tmpdir(), 'fr197-recovery-'));

  const firstTransport = new Transport();
  const firstCounts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const first = supervisor(
    root,
    directoryWith(firstTransport),
    firstCounts,
    canonicalProfile,
    40,
  );
  const initialResult = await first.tick(1);

  const restartTransport = new Transport();
  const restartCounts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const restart = supervisor(
    root,
    directoryWith(restartTransport),
    restartCounts,
    canonicalProfile,
    100,
  );
  const restartResult = await restart.tick(1);

  const driftTransport = new Transport();
  const driftCounts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const canonical = canonicalProfile();
  const drifted = rewriteProfile(canonical, {
    manifest_fingerprint: 'e'.repeat(64),
  });
  const driftRestart = supervisor(
    root,
    directoryWith(driftTransport),
    driftCounts,
    () => drifted,
    200,
  );
  let driftError = null;
  try {
    await driftRestart.tick(1);
  } catch (caught) {
    driftError = caught instanceof Error ? caught.message : String(caught);
  }

  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    initialResult,
    restartResult,
    firstCounts,
    restartCounts,
    driftCounts,
    firstTransportCalls: firstTransport.calls,
    restartTransportCalls: restartTransport.calls,
    driftTransportCalls: driftTransport.calls,
    eventStates: events.map((event) => event.state),
    driftError,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

console.log(JSON.stringify({
  profile: await profileDrift(),
  binding: await bindingDrift(),
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


class FactoryRunnerBrowserPlacementRuntimeDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_profile_or_binding_drift_blocks_before_ack_and_transport(self):
        profile = self.observed["profile"]
        self.assertEqual(profile["first"], {"processed": 1, "cursor": None})
        self.assertIsNotNone(profile["secondError"])
        self.assertEqual(profile["counts"]["placement"], 2)
        self.assertEqual(profile["counts"]["request"], 2)
        self.assertEqual(profile["counts"]["ack"], 1)
        self.assertEqual(profile["transportCalls"], 1)
        self.assertEqual(profile["eventStates"], ["accepted", "started", "completed"])

        binding = self.observed["binding"]
        self.assertEqual(binding["first"], {"processed": 1, "cursor": None})
        self.assertIsNotNone(binding["secondError"])
        self.assertEqual(binding["counts"]["placement"], 2)
        self.assertEqual(binding["counts"]["request"], 2)
        self.assertEqual(binding["counts"]["ack"], 1)
        self.assertEqual(binding["primaryCalls"], 1)
        self.assertEqual(binding["secondaryCalls"], 0)
        self.assertEqual(binding["eventStates"], ["accepted", "started", "completed"])

    def test_recovery_revalidates_placement_without_transport_replay(self):
        recovery = self.observed["recovery"]
        self.assertEqual(recovery["initialResult"], {"processed": 1, "cursor": None})
        self.assertEqual(recovery["firstCounts"]["placement"], 1)
        self.assertEqual(recovery["firstCounts"]["ack"], 1)
        self.assertEqual(recovery["firstTransportCalls"], 1)

        self.assertEqual(recovery["restartResult"], {"processed": 1, "cursor": None})
        self.assertEqual(recovery["restartCounts"]["placement"], 1)
        self.assertEqual(recovery["restartCounts"]["request"], 1)
        self.assertEqual(recovery["restartCounts"]["ack"], 0)
        self.assertEqual(recovery["restartCounts"]["publish"], 0)
        self.assertEqual(recovery["restartTransportCalls"], 0)

        self.assertIsNotNone(recovery["driftError"])
        self.assertEqual(recovery["driftCounts"]["placement"], 1)
        self.assertEqual(recovery["driftCounts"]["request"], 1)
        self.assertEqual(recovery["driftCounts"]["ack"], 0)
        self.assertEqual(recovery["driftCounts"]["publish"], 0)
        self.assertEqual(recovery["driftTransportCalls"], 0)
        self.assertEqual(recovery["eventStates"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
