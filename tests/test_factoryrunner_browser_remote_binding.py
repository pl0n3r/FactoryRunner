"""Aceptación del binding browser remoto fail-closed (#164)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { bindBrowserRemoteAdapter } from './src/browser-remote-binding.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';

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
      ref: 'browserref:binding-0164',
    };
  }
}

const transport = new FakeTransport();
const adapter = bindBrowserRemoteAdapter({
  profile: profile(),
  transport,
  allowed_origins: ['https://example.com'],
  context: context(),
  capability: 'browser.navigate',
});

const result = await adapter.execute(
  'browser.navigate',
  { url: 'https://example.com/remote-binding' },
);

function rejected(input) {
  try {
    bindBrowserRemoteAdapter(input);
    return false;
  } catch {
    return true;
  }
}

function baseline(transportInput = new FakeTransport()) {
  return {
    profile: profile(),
    transport: transportInput,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  };
}

const runnerTransport = new FakeTransport();
const runnerMismatch = rejected({
  ...baseline(runnerTransport),
  context: context({
    runner_id: '33333333-3333-7333-8333-333333333333',
  }),
});

const locationTransport = new FakeTransport();
const locationMismatch = rejected({
  ...baseline(locationTransport),
  context: context({ location: 'macos-local' }),
});

const capabilityTransport = new FakeTransport();
const capabilityMismatch = rejected({
  ...baseline(capabilityTransport),
  capability: 'browser.click_ref',
});

const missingTransport = new FakeTransport();
const missingProfile = rejected({
  transport: missingTransport,
  allowed_origins: ['https://example.com'],
  context: context(),
  capability: 'browser.navigate',
});

const tamperedTransport = new FakeTransport();
const canonical = profile();
const tamperedProfile = rejected({
  ...baseline(tamperedTransport),
  profile: {
    ...canonical,
    fingerprint: 'f'.repeat(64),
  },
});

const expandedAuthorityTransport = new FakeTransport();
const expandedAuthority = rejected({
  ...baseline(expandedAuthorityTransport),
  profile: {
    ...canonical,
    authority: 'expanded',
  },
});

const extraFieldTransport = new FakeTransport();
const extraField = rejected({
  ...baseline(extraFieldTransport),
  token: 'do-not-accept',
});

console.log(JSON.stringify({
  result,
  transportCalls: transport.calls,
  requests: transport.requests,
  runnerMismatch,
  runnerMismatchCalls: runnerTransport.calls,
  locationMismatch,
  locationMismatchCalls: locationTransport.calls,
  capabilityMismatch,
  capabilityMismatchCalls: capabilityTransport.calls,
  missingProfile,
  missingProfileCalls: missingTransport.calls,
  tamperedProfile,
  tamperedProfileCalls: tamperedTransport.calls,
  expandedAuthority,
  expandedAuthorityCalls: expandedAuthorityTransport.calls,
  extraField,
  extraFieldCalls: extraFieldTransport.calls,
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


class FactoryRunnerBrowserRemoteBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_binding_requires_matching_runner_location_and_capability(self):
        self.assertEqual(
            self.observed["result"],
            {"capability": "browser.navigate", "status": "ok", "ref": "browserref:binding-0164"},
        )
        self.assertEqual(self.observed["transportCalls"], 1)
        requests = self.observed["requests"]
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(requests[0]["location"], "hostinger-shared")
        self.assertEqual(requests[0]["capability"], "browser.navigate")
        for key in ("runnerMismatch", "locationMismatch", "capabilityMismatch"):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])
        self.assertEqual(self.observed["runnerMismatchCalls"], 0)
        self.assertEqual(self.observed["locationMismatchCalls"], 0)
        self.assertEqual(self.observed["capabilityMismatchCalls"], 0)

    def test_missing_or_tampered_remote_profile_blocks_before_driver_call(self):
        for key in (
            "missingProfile",
            "tamperedProfile",
            "expandedAuthority",
            "extraField",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])
        self.assertEqual(self.observed["missingProfileCalls"], 0)
        self.assertEqual(self.observed["tamperedProfileCalls"], 0)
        self.assertEqual(self.observed["expandedAuthorityCalls"], 0)
        self.assertEqual(self.observed["extraFieldCalls"], 0)


if __name__ == "__main__":
    unittest.main()
