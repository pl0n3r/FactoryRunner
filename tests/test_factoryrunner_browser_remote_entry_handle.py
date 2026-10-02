"""Aceptación del handle in-memory de entry browser remoto (#216)."""
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

class MutableTransport {
  calls = 0;
  tags = [];

  async execute(request) {
    this.calls += 1;
    this.tags.push(request.tag);
    return {
      source: 'original',
      calls: this.calls,
      tag: request.tag,
    };
  }
}

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const transport = new MutableTransport();
const originalExecute = transport.execute;
const entry = Object.freeze({ profile, transport });
const handle = browserRemoteEntryHandle(entry);

const exactProfile = handle.profile === profile;
const sameExecuteReference = handle.execute === originalExecute;
const frozen = Object.isFrozen(handle);
const bindingFingerprint = handle.binding_fingerprint;

let hijackCalls = 0;
transport.execute = async function (request) {
  hijackCalls += 1;
  this.tags.push('hijacked:' + request.tag);
  return { source: 'hijacked' };
};

const first = await handle.invoke({ tag: 'first' });
transport.tags.push('external-state');
const second = await handle.invoke({ tag: 'second' });

const tamperedProfileRejected = rejected(() => {
  browserRemoteEntryHandle({
    profile: { ...profile, fingerprint: '0'.repeat(64) },
    transport,
  });
});
const invalidTransportRejected = rejected(() => {
  browserRemoteEntryHandle({ profile, transport: {} });
});
const extraEntryFieldRejected = rejected(() => {
  browserRemoteEntryHandle({ profile, transport, endpoint: 'https://example.test' });
});

console.log(JSON.stringify({
  exactProfile,
  sameExecuteReference,
  frozen,
  bindingFingerprint,
  expectedFingerprint: profile.fingerprint,
  first,
  second,
  calls: transport.calls,
  tags: transport.tags,
  hijackCalls,
  currentTransportIsHijacked: transport.execute !== originalExecute,
  tamperedProfileRejected,
  invalidTransportRejected,
  extraEntryFieldRejected,
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


class FactoryRunnerBrowserRemoteEntryHandleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_handle_captures_exact_entry_profile_and_execute_reference(self):
        self.assertTrue(self.observed["exactProfile"])
        self.assertTrue(self.observed["sameExecuteReference"])
        self.assertTrue(self.observed["frozen"])
        self.assertEqual(
            self.observed["bindingFingerprint"],
            self.observed["expectedFingerprint"],
        )
        self.assertTrue(self.observed["tamperedProfileRejected"])
        self.assertTrue(self.observed["invalidTransportRejected"])
        self.assertTrue(self.observed["extraEntryFieldRejected"])

    def test_handle_ignores_later_transport_method_swap_and_preserves_internal_state(self):
        self.assertTrue(self.observed["currentTransportIsHijacked"])
        self.assertEqual(self.observed["hijackCalls"], 0)
        self.assertEqual(
            self.observed["first"],
            {"source": "original", "calls": 1, "tag": "first"},
        )
        self.assertEqual(
            self.observed["second"],
            {"source": "original", "calls": 2, "tag": "second"},
        )
        self.assertEqual(self.observed["calls"], 2)
        self.assertEqual(
            self.observed["tags"],
            ["first", "external-state", "second"],
        )


if __name__ == "__main__":
    unittest.main()
