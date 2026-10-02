"""Aceptación del resolver que consume un handle one-shot (#223)."""
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

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';

class Transport {
  calls = 0;
  async execute(request) {
    this.calls += 1;
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:handle-consume-0223',
    };
  }
}

function context(overrides = {}) {
  return {
    runner_id: RUNNER,
    order_id: ORDER,
    location: 'hostinger-shared',
    ...overrides,
  };
}

function resolve(handle, overrides = {}) {
  return resolveBrowserRemoteHandleAdapter({
    handle,
    allowed_origins: ['https://example.com'],
    context: context(overrides.context),
    capability: overrides.capability ?? 'browser.navigate',
    binding_fingerprint:
      overrides.binding_fingerprint ?? handle.binding_fingerprint,
  });
}

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

async function rejectedAsync(callback) {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

const transport = new Transport();
const directory = new BrowserRemoteDirectory();
const entry = directory.register({
  profile: browserRemoteProfile({
    version: 1,
    runner_id: RUNNER,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
  }),
  transport,
});
const handle = browserRemoteEntryHandle(entry);

let directoryReads = 0;
directory.entries = () => {
  directoryReads += 1;
  throw new Error('directory reread forbidden');
};

const firstAdapter = resolve(handle);
const secondAdapter = resolve(handle);
const first = await firstAdapter.execute(
  'browser.navigate',
  { url: 'https://example.com/consume-once' },
);
const secondRejected = await rejectedAsync(() => secondAdapter.execute(
  'browser.navigate',
  { url: 'https://example.com/replay' },
));

const badFingerprint = rejected(() => resolve(handle, {
  binding_fingerprint: '0'.repeat(64),
}));
const badRunner = rejected(() => resolve(handle, {
  context: { runner_id: '33333333-3333-7333-8333-333333333333' },
}));
const badLocation = rejected(() => resolve(handle, {
  context: { location: 'macos-local' },
}));
const badCapability = rejected(() => resolve(handle, {
  capability: 'browser.click_ref',
}));

console.log(JSON.stringify({
  first,
  secondRejected,
  transportCalls: transport.calls,
  directoryReads,
  badFingerprint,
  badRunner,
  badLocation,
  badCapability,
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


class FactoryRunnerBrowserRemoteHandleConsumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_handle_resolver_uses_pinned_handle_without_directory_reread_and_consumes_once(self):
        self.assertEqual(self.observed["directoryReads"], 0)
        self.assertEqual(self.observed["transportCalls"], 1)
        self.assertTrue(self.observed["secondRejected"])
        self.assertEqual(
            self.observed["first"],
            {
                "capability": "browser.navigate",
                "status": "ok",
                "ref": "browserref:handle-consume-0223",
            },
        )

    def test_fingerprint_or_context_drift_fails_closed_before_transport_without_second_execution(self):
        for key in ("badFingerprint", "badRunner", "badLocation", "badCapability"):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])
        self.assertEqual(self.observed["transportCalls"], 1)
        self.assertEqual(self.observed["directoryReads"], 0)


if __name__ == "__main__":
    unittest.main()
