"""Aceptación de RuntimeSupervisor + browser remoto plan-bound (#178)."""
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
import { browserPlanStep } from './src/browser-plan.ts';
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { createBrowserRemoteSupervisor } from './src/browser-remote-supervisor.ts';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const NOW = 2200;

const identity = {
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.4',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 1,
};

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:178',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 2100,
  expires_at: 2300,
  instruction_ref: 'controlbot:instruction:factoryrunner-178',
};
const orderHash = orderFingerprint(order);

function placementProfile() {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    observed_at: NOW,
    host_local_proven: false,
    remote_capable_proven: true,
    status: 'KNOWN',
    identity_fingerprint: stableSha256(identity),
    resource_fingerprint: 'c'.repeat(64),
    manifest_fingerprint: 'b'.repeat(64),
    evidence_fingerprint: 'd'.repeat(64),
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function signedAdmission() {
  const core = {
    version: 1,
    decision: 'ALLOW',
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    work_item_id: order.work_item_id,
    observed_at: NOW,
    order_fingerprint: orderHash,
    manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function signedPlan(admission, adapterId = 'browser-execution') {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    work_item_id: order.work_item_id,
    capability: order.capability,
    order_fingerprint: orderHash,
    admission_fingerprint: admission.fingerprint,
    adapter_id: adapterId,
    manifest_fingerprint: admission.manifest_fingerprint,
    resource_fingerprint: admission.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function requestFor(plan) {
  const step = browserPlanStep(order, plan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: 'https://example.com/remote-supervisor' },
  });
  return browserLoopRequest(order, plan, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
}

class FakeTransport {
  calls = 0;
  requests = [];

  async execute(request) {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:remote-0178',
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
  const root = mkdtempSync(join(tmpdir(), 'factoryrunner-178-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const transport = new FakeTransport();
  const directory = new BrowserRemoteDirectory();
  const profileLocation = kind === 'profile' ? 'macos-local' : 'hostinger-shared';
  directory.register({
    profile: browserRemoteProfile({
      version: 1,
      runner_id: RUNNER_ID,
      location: profileLocation,
      capability: 'browser.navigate',
      remote_alias: 'browser-primary',
    }),
    transport,
  });

  const admission = signedAdmission();
  const canonicalPlan = signedPlan(admission);
  const request = requestFor(canonicalPlan);
  const counts = { ack: 0, publish: 0, plan: 0, request: 0 };

  const client = {
    async poll() {
      return { version: 1, cursor: null, orders: [{ ...order, fingerprint: orderHash }] };
    },
    validatedOrder(orderId) {
      if (orderId !== ORDER_ID) throw new TypeError('unknown order');
      return order;
    },
    async ack() { counts.ack += 1; },
    async publishEvents() { counts.publish += 1; },
    async publishHeartbeat() {},
  };

  const supervisor = createBrowserRemoteSupervisor({
    client,
    journal,
    outbox,
    registry: registry(),
    identity,
    directory,
    allowed_origins: ['https://example.com'],
    admission: () => admission,
    plan: () => {
      counts.plan += 1;
      if (kind === 'plan' && counts.plan === 2) {
        return signedPlan(admission, 'browser-other');
      }
      return canonicalPlan;
    },
    placement_profile: () => placementProfile(),
    browser_request: () => {
      counts.request += 1;
      if (kind === 'request') {
        return { ...request, plan_fingerprint: 'f'.repeat(64) };
      }
      return request;
    },
    now: () => NOW,
    event_id: ids(),
  });

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
    transportRequest: transport.requests[0] ?? null,
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
  plan: await scenario('plan'),
  request: await scenario('request'),
  profile: await scenario('profile'),
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


class FactoryRunnerBrowserRemoteSupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_executes_plan_bound_remote_browser_through_fake_transport(self):
        valid = self.observed["valid"]
        self.assertEqual(valid["result"], {"processed": 1, "cursor": None})
        self.assertIsNone(valid["error"])
        self.assertEqual(valid["transportCalls"], 1)
        self.assertEqual(valid["counts"], {"ack": 1, "publish": 1, "plan": 2, "request": 1})
        request = valid["transportRequest"]
        self.assertEqual(request["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(request["location"], "hostinger-shared")
        self.assertEqual(request["capability"], "browser.navigate")
        self.assertEqual(request["remote_alias"], "browser-primary")
        self.assertEqual(valid["events"][-1]["state"], "completed")

    def test_tampered_plan_request_or_profile_fails_closed_before_remote_call(self):
        plan = self.observed["plan"]
        self.assertEqual(plan["result"], {"processed": 0, "cursor": None})
        self.assertIsNone(plan["error"])
        self.assertEqual(plan["transportCalls"], 0)
        self.assertEqual(plan["counts"]["ack"], 0)
        self.assertEqual(plan["events"], [])

        for key in ("request", "profile"):
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertIsNotNone(item["error"])
                self.assertEqual(item["transportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
