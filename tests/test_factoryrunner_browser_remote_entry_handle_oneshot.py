"""Aceptación del consumo one-shot de BrowserRemoteEntryHandle (#222)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteEntryHandle } from './src/browser-remote-entry-handle.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const profile = browserRemoteProfile({
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});

const request = Object.freeze({
  version: 1,
  authority: 'unchanged',
  profile_fingerprint: profile.fingerprint,
  runner_id: profile.runner_id,
  location: profile.location,
  capability: profile.capability,
  remote_alias: profile.remote_alias,
  command: Object.freeze({
    kind: 'navigate',
    session_key: 'browsersession:' + 'a'.repeat(64),
    url: 'https://example.com/oneshot',
  }),
  request_fingerprint: 'b'.repeat(64),
});

class SuccessTransport {
  calls = 0;

  async execute(incoming) {
    this.calls += 1;
    return { call: this.calls, fingerprint: incoming.request_fingerprint };
  }
}

class FailingTransport {
  calls = 0;

  async execute() {
    this.calls += 1;
    throw new Error('first-effect-failed');
  }
}

async function rejection(callback) {
  try {
    await callback();
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

const successTransport = new SuccessTransport();
const successHandle = browserRemoteEntryHandle(
  Object.freeze({ profile, transport: successTransport }),
);
const firstResult = await successHandle.invoke(request);
const secondError = await rejection(() => successHandle.invoke(request));

const failingTransport = new FailingTransport();
const failingHandle = browserRemoteEntryHandle(
  Object.freeze({ profile, transport: failingTransport }),
);
const firstFailure = await rejection(() => failingHandle.invoke(request));
const replayFailure = await rejection(() => failingHandle.invoke(request));

console.log(JSON.stringify({
  firstResult,
  successCalls: successTransport.calls,
  secondError,
  firstFailure,
  replayFailure,
  failingCalls: failingTransport.calls,
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


class FactoryRunnerBrowserRemoteEntryHandleOneshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_handle_consumes_once_and_second_invoke_fails_before_transport(self):
        self.assertEqual(
            self.observed["firstResult"],
            {"call": 1, "fingerprint": "b" * 64},
        )
        self.assertEqual(self.observed["successCalls"], 1)
        self.assertIn("consumido", self.observed["secondError"])

    def test_transport_failure_still_consumes_handle_and_prevents_replay(self):
        self.assertEqual(self.observed["firstFailure"], "first-effect-failed")
        self.assertIn("consumido", self.observed["replayFailure"])
        self.assertEqual(self.observed["failingCalls"], 1)


if __name__ == "__main__":
    unittest.main()
