"""Aceptación del resolver browser remoto exacto (#174)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { resolveBrowserRemoteAdapter } from './src/browser-remote-resolver.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_RUNNER_ID = '33333333-3333-7333-8333-333333333333';
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
      ref: 'browserref:resolver-0174',
    };
  }
}

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

function context(overrides = {}) {
  return {
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    location: 'hostinger-shared',
    ...overrides,
  };
}

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const transport = new FakeTransport();
const directory = new BrowserRemoteDirectory();
directory.register({
  profile: profile(),
  transport,
});

const adapter = resolveBrowserRemoteAdapter({
  directory,
  allowed_origins: ['https://example.com'],
  context: context(),
  capability: 'browser.navigate',
});
const callsBeforeExecute = transport.calls;
const result = await adapter.execute(
  'browser.navigate',
  { url: 'https://example.com/remote-resolver' },
);
const callsAfterExecute = transport.calls;

const missingTransport = new FakeTransport();
const missingDirectory = new BrowserRemoteDirectory();
const missingRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: missingDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const ambiguousTransportA = new FakeTransport();
const ambiguousTransportB = new FakeTransport();
const ambiguousDirectory = new BrowserRemoteDirectory();
ambiguousDirectory.register({
  profile: profile({ remote_alias: 'browser-primary-a' }),
  transport: ambiguousTransportA,
});
ambiguousDirectory.register({
  profile: profile({ remote_alias: 'browser-primary-b' }),
  transport: ambiguousTransportB,
});
const ambiguousRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: ambiguousDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const runnerTransport = new FakeTransport();
const runnerDirectory = new BrowserRemoteDirectory();
runnerDirectory.register({
  profile: profile({ runner_id: OTHER_RUNNER_ID }),
  transport: runnerTransport,
});
const runnerMismatchRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: runnerDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const locationTransport = new FakeTransport();
const locationDirectory = new BrowserRemoteDirectory();
locationDirectory.register({
  profile: profile({ location: 'macos-local' }),
  transport: locationTransport,
});
const locationMismatchRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: locationDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const capabilityTransport = new FakeTransport();
const capabilityDirectory = new BrowserRemoteDirectory();
capabilityDirectory.register({
  profile: profile({ capability: 'browser.click_ref' }),
  transport: capabilityTransport,
});
const capabilityMismatchRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: capabilityDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const fakeDirectoryRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory: { entries() { return directory.entries(); } },
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const extraFieldRejected = rejected(() => {
  resolveBrowserRemoteAdapter({
    directory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    provider: 'forbidden',
  });
});

console.log(JSON.stringify({
  result,
  callsBeforeExecute,
  callsAfterExecute,
  selectedRequest: transport.requests[0] ?? null,
  missingRejected,
  missingCalls: missingTransport.calls,
  ambiguousRejected,
  ambiguousCalls: ambiguousTransportA.calls + ambiguousTransportB.calls,
  runnerMismatchRejected,
  runnerMismatchCalls: runnerTransport.calls,
  locationMismatchRejected,
  locationMismatchCalls: locationTransport.calls,
  capabilityMismatchRejected,
  capabilityMismatchCalls: capabilityTransport.calls,
  fakeDirectoryRejected,
  extraFieldRejected,
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


class FactoryRunnerBrowserRemoteResolverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_resolver_selects_exact_profile_and_builds_adapter_without_eager_transport_call(self):
        self.assertEqual(self.observed["callsBeforeExecute"], 0)
        self.assertEqual(self.observed["callsAfterExecute"], 1)
        self.assertEqual(
            self.observed["result"],
            {
                "capability": "browser.navigate",
                "status": "ok",
                "ref": "browserref:resolver-0174",
            },
        )
        request = self.observed["selectedRequest"]
        self.assertEqual(request["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(request["location"], "hostinger-shared")
        self.assertEqual(request["capability"], "browser.navigate")
        self.assertEqual(request["remote_alias"], "browser-primary")

    def test_missing_ambiguous_or_mismatched_profile_fails_closed(self):
        for key in (
            "missingRejected",
            "ambiguousRejected",
            "runnerMismatchRejected",
            "locationMismatchRejected",
            "capabilityMismatchRejected",
            "fakeDirectoryRejected",
            "extraFieldRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])

        self.assertEqual(self.observed["missingCalls"], 0)
        self.assertEqual(self.observed["ambiguousCalls"], 0)
        self.assertEqual(self.observed["runnerMismatchCalls"], 0)
        self.assertEqual(self.observed["locationMismatchCalls"], 0)
        self.assertEqual(self.observed["capabilityMismatchCalls"], 0)


if __name__ == "__main__":
    unittest.main()
