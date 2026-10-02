"""Aceptación del resolver browser remoto pinneado (#203)."""
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
import {
  resolvePinnedBrowserRemoteAdapter,
} from './src/browser-remote-resolver.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';

class FakeTransport {
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
      ref: 'browserref:resolver-pin-0203',
    };
  }
}

function profile(alias) {
  return browserRemoteProfile({
    version: 1,
    runner_id: RUNNER_ID,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: alias,
  });
}

function context() {
  return {
    runner_id: RUNNER_ID,
    order_id: ORDER_ID,
    location: 'hostinger-shared',
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

const primaryProfile = profile('browser-primary');
const substituteProfile = profile('browser-substitute');
const primaryTransport = new FakeTransport('primary');
const substituteTransport = new FakeTransport('substitute');

const directory = new BrowserRemoteDirectory();
directory.register({ profile: primaryProfile, transport: primaryTransport });
directory.register({ profile: substituteProfile, transport: substituteTransport });

const adapter = resolvePinnedBrowserRemoteAdapter({
  directory,
  allowed_origins: ['https://example.com'],
  context: context(),
  capability: 'browser.navigate',
  binding_fingerprint: primaryProfile.fingerprint,
});

const beforeExecute = {
  primary: primaryTransport.calls,
  substitute: substituteTransport.calls,
};
const result = await adapter.execute(
  'browser.navigate',
  { url: 'https://example.com/pinned-resolver' },
);
const afterExecute = {
  primary: primaryTransport.calls,
  substitute: substituteTransport.calls,
};

const missingFingerprintRejected = rejected(() => {
  resolvePinnedBrowserRemoteAdapter({
    directory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
  });
});

const malformedFingerprintRejected = rejected(() => {
  resolvePinnedBrowserRemoteAdapter({
    directory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: 'not-a-sha256',
  });
});

const substituteOnlyDirectory = new BrowserRemoteDirectory();
const substituteOnlyTransport = new FakeTransport('substitute-only');
substituteOnlyDirectory.register({
  profile: substituteProfile,
  transport: substituteOnlyTransport,
});
const changedPinnedBindingRejected = rejected(() => {
  resolvePinnedBrowserRemoteAdapter({
    directory: substituteOnlyDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: primaryProfile.fingerprint,
  });
});

const missingDirectory = new BrowserRemoteDirectory();
const missingTransport = new FakeTransport('missing');
const missingPinnedBindingRejected = rejected(() => {
  resolvePinnedBrowserRemoteAdapter({
    directory: missingDirectory,
    allowed_origins: ['https://example.com'],
    context: context(),
    capability: 'browser.navigate',
    binding_fingerprint: primaryProfile.fingerprint,
  });
});

console.log(JSON.stringify({
  result,
  primaryFingerprint: primaryProfile.fingerprint,
  substituteFingerprint: substituteProfile.fingerprint,
  beforeExecute,
  afterExecute,
  selectedRequest: primaryTransport.requests[0] ?? null,
  missingFingerprintRejected,
  malformedFingerprintRejected,
  changedPinnedBindingRejected,
  changedPinnedBindingCalls: substituteOnlyTransport.calls,
  missingPinnedBindingRejected,
  missingPinnedBindingCalls: missingTransport.calls,
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


class FactoryRunnerBrowserRemoteResolverPinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_resolver_requires_expected_binding_fingerprint_and_never_substitutes_same_capability_profile(self):
        self.assertNotEqual(
            self.observed["primaryFingerprint"],
            self.observed["substituteFingerprint"],
        )
        self.assertEqual(
            self.observed["beforeExecute"],
            {"primary": 0, "substitute": 0},
        )
        self.assertEqual(
            self.observed["afterExecute"],
            {"primary": 1, "substitute": 0},
        )
        self.assertEqual(
            self.observed["result"],
            {
                "capability": "browser.navigate",
                "status": "ok",
                "ref": "browserref:resolver-pin-0203",
            },
        )
        self.assertEqual(
            self.observed["selectedRequest"]["profile_fingerprint"],
            self.observed["primaryFingerprint"],
        )

    def test_missing_or_changed_pinned_binding_fails_closed_before_transport(self):
        for key in (
            "missingFingerprintRejected",
            "malformedFingerprintRejected",
            "changedPinnedBindingRejected",
            "missingPinnedBindingRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])

        self.assertEqual(self.observed["changedPinnedBindingCalls"], 0)
        self.assertEqual(self.observed["missingPinnedBindingCalls"], 0)


if __name__ == "__main__":
    unittest.main()
