"""Aceptación del driver browser remoto provider-neutral (#163)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { BrowserRemoteDriver } from './src/browser-remote-driver.ts';

const profile = browserRemoteProfile({
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});

class FakeTransport {
  requests = [];
  async execute(request) {
    this.requests.push(structuredClone(request));
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:remote-0163',
    };
  }
}

const transport = new FakeTransport();
const driver = new BrowserRemoteDriver(profile, transport);
const result = await driver.execute({
  kind: 'navigate',
  session_key: 'browsersession:' + 'a'.repeat(64),
  url: 'https://example.com/remote',
});

async function rejected(responseFactory) {
  const badTransport = {
    async execute(request) {
      return responseFactory(request);
    },
  };
  const badDriver = new BrowserRemoteDriver(profile, badTransport);
  try {
    await badDriver.execute({
      kind: 'navigate',
      session_key: 'browsersession:' + 'b'.repeat(64),
      url: 'https://example.com/remote',
    });
    return false;
  } catch {
    return true;
  }
}

const mismatched = await rejected((request) => ({
  version: 1,
  authority: 'unchanged',
  request_fingerprint: 'f'.repeat(64),
  status: 'ok',
  ref: 'browserref:remote-0163',
}));

const extraEvidence = await rejected((request) => ({
  version: 1,
  authority: 'unchanged',
  request_fingerprint: request.request_fingerprint,
  status: 'ok',
  ref: 'browserref:remote-0163',
  html: '<html>secret</html>',
}));

const sensitiveRef = await rejected((request) => ({
  version: 1,
  authority: 'unchanged',
  request_fingerprint: request.request_fingerprint,
  status: 'ok',
  ref: 'token=do-not-accept',
}));

const changedAuthority = await rejected((request) => ({
  version: 1,
  authority: 'expanded',
  request_fingerprint: request.request_fingerprint,
  status: 'ok',
  ref: 'browserref:remote-0163',
}));

const invalidStatus = await rejected((request) => ({
  version: 1,
  authority: 'unchanged',
  request_fingerprint: request.request_fingerprint,
  status: 'debug',
  ref: 'browserref:remote-0163',
}));

let mismatchedCapability = false;
try {
  await driver.execute({
    kind: 'click_ref',
    session_key: 'browsersession:' + 'c'.repeat(64),
    ref: 'browserref:element-0163',
  });
} catch {
  mismatchedCapability = true;
}

console.log(JSON.stringify({
  result,
  requests: transport.requests,
  mismatched,
  extraEvidence,
  sensitiveRef,
  changedAuthority,
  invalidStatus,
  mismatchedCapability,
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


class FactoryRunnerBrowserRemoteDriverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_remote_driver_maps_commands_to_typed_fake_transport_without_network(self):
        self.assertEqual(
            self.observed["result"],
            {"status": "ok", "ref": "browserref:remote-0163"},
        )
        requests = self.observed["requests"]
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request["version"], 1)
        self.assertEqual(request["authority"], "unchanged")
        self.assertEqual(
            request["runner_id"],
            "11111111-1111-7111-8111-111111111111",
        )
        self.assertEqual(request["location"], "hostinger-shared")
        self.assertEqual(request["capability"], "browser.navigate")
        self.assertEqual(request["remote_alias"], "browser-primary")
        self.assertRegex(request["profile_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(request["request_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            request["command"],
            {
                "kind": "navigate",
                "session_key": "browsersession:" + "a" * 64,
                "url": "https://example.com/remote",
            },
        )
        serialized = json.dumps(request).lower()
        for forbidden in (
            "endpoint",
            "provider",
            "credential",
            "cookie",
            "authorization",
            "websocket",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

    def test_invalid_or_mismatched_response_fails_closed_without_sensitive_evidence(self):
        for key in (
            "mismatched",
            "extraEvidence",
            "sensitiveRef",
            "changedAuthority",
            "invalidStatus",
            "mismatchedCapability",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])


if __name__ == "__main__":
    unittest.main()
