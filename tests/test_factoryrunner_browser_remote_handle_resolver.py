"""Aceptación del resolver browser remoto desde handle pinneado (#217)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteEntryHandle } from './src/browser-remote-entry-handle.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { resolveBrowserRemoteHandleAdapter } from './src/browser-remote-resolver.ts';

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
      ref: 'browserref:handle-resolver-0217',
    };
  }
}

function profile() {
  return browserRemoteProfile({
    version: 1,
    runner_id: RUNNER_ID,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
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
const entry = directory.register({ profile: profile(), transport });
const handle = browserRemoteEntryHandle(entry);

let directoryReads = 0;
directory.entries = () => {
  directoryReads += 1;
  throw new Error('directory reread forbidden after handle pin');
};

const adapter = resolveBrowserRemoteHandleAdapter({
  handle,
  allowed_origins: ['https://example.com'],
  context: context(),
  capability: 'browser.navigate',
  binding_fingerprint: handle.binding_fingerprint,
});
const callsBeforeExecute = transport.calls;
const result = await adapter.execute(
  'browser.navigate',
  { url: 'https://example.com/handle-resolver' },
);
const callsAfterExecute = transport.calls;

const badFingerprint = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: '0'.repeat(64),
  });
});

const badRunner = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context({ runner_id: OTHER_RUNNER_ID }),
    capability: 'browser.navigate',
    binding_fingerprint: handle.binding_fingerprint,
  });
});

const badLocation = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context({ location: 'macos-local' }),
    capability: 'browser.navigate',
    binding_fingerprint: handle.binding_fingerprint,
  });
});

const badCapability = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.click_ref',
    binding_fingerprint: handle.binding_fingerprint,
  });
});

const forgedHandle = Object.freeze({
  ...handle,
  binding_fingerprint: 'f'.repeat(64),
});
const forgedHandleRejected = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle: forgedHandle,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: handle.binding_fingerprint,
  });
});

const extraFieldRejected = rejected(() => {
  resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: handle.binding_fingerprint,
    directory,
  });
});

console.log(JSON.stringify({
  result,
  callsBeforeExecute,
  callsAfterExecute,
  directoryReads,
  selectedRequest: transport.requests[0] ?? null,
  badFingerprint,
  badRunner,
  badLocation,
  badCapability,
  forgedHandleRejected,
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


class FactoryRunnerBrowserRemoteHandleResolverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_handle_resolver_binds_exact_pinned_entry_without_directory_reread(self):
        self.assertEqual(self.observed["directoryReads"], 0)
        self.assertEqual(self.observed["callsBeforeExecute"], 0)
        self.assertEqual(self.observed["callsAfterExecute"], 1)
        self.assertEqual(
            self.observed["result"],
            {
                "capability": "browser.navigate",
                "status": "ok",
                "ref": "browserref:handle-resolver-0217",
            },
        )
        request = self.observed["selectedRequest"]
        self.assertEqual(request["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(request["location"], "hostinger-shared")
        self.assertEqual(request["capability"], "browser.navigate")
        self.assertEqual(request["remote_alias"], "browser-primary")

    def test_handle_resolver_rejects_fingerprint_or_context_drift_fail_closed(self):
        for key in (
            "badFingerprint",
            "badRunner",
            "badLocation",
            "badCapability",
            "forgedHandleRejected",
            "extraFieldRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])
        self.assertEqual(self.observed["callsBeforeExecute"], 0)
        self.assertEqual(self.observed["directoryReads"], 0)


if __name__ == "__main__":
    unittest.main()
