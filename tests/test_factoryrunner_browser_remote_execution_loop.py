"""Aceptación del ExecutionLoop con resolver browser remoto por request (#175)."""
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
import { resolveBrowserRemoteAdapter } from './src/browser-remote-resolver.ts';
import { ExecutionLoop } from './src/execution-loop.ts';
import { DurableJournal } from './src/journal.ts';
import { orderFingerprint } from './src/order.ts';
import { parseRunnerIdentity } from './src/runner.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';

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
      ref: 'browserref:remote-0175',
    };
  }
}

const identity = parseRunnerIdentity({
  version: 1,
  runner_id: RUNNER_ID,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['browser.navigate'],
  max_parallel: 1,
});

const order = {
  version: 1,
  order_id: ORDER_ID,
  work_item_id: 'factoryrunner:work:175',
  runner_id: RUNNER_ID,
  capability: 'browser.navigate',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-175',
};

const planCore = {
  version: 1,
  authority: 'unchanged',
  runner_id: RUNNER_ID,
  order_id: ORDER_ID,
  work_item_id: order.work_item_id,
  capability: order.capability,
  order_fingerprint: orderFingerprint(order),
  admission_fingerprint: 'a'.repeat(64),
  adapter_id: 'browser-execution',
  manifest_fingerprint: 'b'.repeat(64),
  resource_fingerprint: 'c'.repeat(64),
};
const plan = { ...planCore, fingerprint: stableSha256(planCore) };
const step = browserPlanStep(order, plan, {
  version: 1,
  adapter_id: 'browser-execution',
  capability: 'browser.navigate',
  payload: { url: 'https://example.com/remote-loop' },
});
const request = browserLoopRequest(order, plan, {
  version: 1,
  browser_kind: 'step',
  browser: step,
});

const dummyRegistry = () => new AdapterRegistry([{
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

function profile(overrides = {}) {
  return browserRemoteProfile({
    version: 1,
    runner_id: RUNNER_ID,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
    ...overrides,
  });
}

function resolver(directory, observed) {
  return (canonicalRequest) => {
    observed.push({
      runner_id: canonicalRequest.runner_id,
      order_id: canonicalRequest.order_id,
      capability: canonicalRequest.capability,
    });
    return resolveBrowserRemoteAdapter({
      directory,
      allowed_origins: ['https://example.com'],
      context: {
        runner_id: canonicalRequest.runner_id,
        order_id: canonicalRequest.order_id,
        location: 'hostinger-shared',
      },
      capability: canonicalRequest.capability,
    });
  };
}

function eventIds() {
  let value = 1;
  return () => `00000000-0000-7000-8000-${String(value++).padStart(12, '0')}`;
}

const root = mkdtempSync(join(tmpdir(), 'factoryrunner-175-'));
try {
  const successTransport = new FakeTransport();
  const successDirectory = new BrowserRemoteDirectory();
  successDirectory.register({
    profile: profile(),
    transport: successTransport,
  });
  const resolverRequests = [];
  const successLoop = new ExecutionLoop({
    journal: new DurableJournal(join(root, 'success.ndjson')),
    registry: dummyRegistry(),
    browser_adapter_resolver: resolver(successDirectory, resolverRequests),
    identity,
    now: () => 1200,
    event_id: eventIds(),
  });
  const success = await successLoop.executeBrowserRequest(order, plan, request);

  const missingTransport = new FakeTransport();
  const missingDirectory = new BrowserRemoteDirectory();
  let missingRejected = false;
  try {
    const missingLoop = new ExecutionLoop({
      journal: new DurableJournal(join(root, 'missing.ndjson')),
      registry: dummyRegistry(),
      browser_adapter_resolver: resolver(missingDirectory, []),
      identity,
      now: () => 1200,
      event_id: eventIds(),
    });
    await missingLoop.executeBrowserRequest(order, plan, request);
  } catch {
    missingRejected = true;
  }

  const mismatchTransport = new FakeTransport();
  const mismatchDirectory = new BrowserRemoteDirectory();
  mismatchDirectory.register({
    profile: profile({ location: 'macos-local' }),
    transport: mismatchTransport,
  });
  let mismatchRejected = false;
  try {
    const mismatchLoop = new ExecutionLoop({
      journal: new DurableJournal(join(root, 'mismatch.ndjson')),
      registry: dummyRegistry(),
      browser_adapter_resolver: resolver(mismatchDirectory, []),
      identity,
      now: () => 1200,
      event_id: eventIds(),
    });
    await mismatchLoop.executeBrowserRequest(order, plan, request);
  } catch {
    mismatchRejected = true;
  }

  console.log(JSON.stringify({
    success,
    resolverRequests,
    transportCalls: successTransport.calls,
    transportRequest: successTransport.requests[0] ?? null,
    missingRejected,
    missingTransportCalls: missingTransport.calls,
    mismatchRejected,
    mismatchTransportCalls: mismatchTransport.calls,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteExecutionLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_execution_loop_uses_remote_adapter_resolver_for_matching_browser_request(self):
        self.assertEqual(
            self.observed["resolverRequests"],
            [{
                "runner_id": "11111111-1111-7111-8111-111111111111",
                "order_id": "22222222-2222-7222-8222-222222222222",
                "capability": "browser.navigate",
            }],
        )
        self.assertEqual(self.observed["transportCalls"], 1)
        request = self.observed["transportRequest"]
        self.assertEqual(request["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(request["location"], "hostinger-shared")
        self.assertEqual(request["capability"], "browser.navigate")
        self.assertEqual(request["remote_alias"], "browser-primary")

        result = self.observed["success"]
        self.assertEqual(result["event"]["state"], "completed")
        self.assertEqual(result["adapter_result"], [{
            "capability": "browser.navigate",
            "status": "ok",
            "ref": "browserref:remote-0175",
        }])

    def test_missing_or_mismatched_remote_binding_blocks_before_transport_call(self):
        self.assertTrue(self.observed["missingRejected"])
        self.assertTrue(self.observed["mismatchRejected"])
        self.assertEqual(self.observed["missingTransportCalls"], 0)
        self.assertEqual(self.observed["mismatchTransportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
