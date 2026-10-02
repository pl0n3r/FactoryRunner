"""Aceptación del sellado de transport browser remoto (#210)."""
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

const profile = browserRemoteProfile({
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});

class StatefulTransport {
  calls = 0;
  tags = [];

  async execute(request) {
    this.calls += 1;
    this.tags.push(request.tag);
    return { source: 'original', calls: this.calls };
  }
}

const transport = new StatefulTransport();
const originalExecute = transport.execute;
const directory = new BrowserRemoteDirectory();
const entry = directory.register({ profile, transport });
const descriptor = Object.getOwnPropertyDescriptor(transport, 'execute');

let swapRejected = false;
try {
  transport.execute = async () => ({ source: 'hijacked' });
} catch {
  swapRejected = true;
}

const first = await entry.transport.execute({ tag: 'first' });
transport.tags.push('external-state-still-mutable');
const second = await directory.lookup('browser-primary').transport.execute({ tag: 'second' });

let prototypeHijackCalls = 0;
StatefulTransport.prototype.execute = async function () {
  prototypeHijackCalls += 1;
  return { source: 'prototype-hijack' };
};
const third = await entry.transport.execute({ tag: 'third' });

console.log(JSON.stringify({
  sameTransportObject: entry.transport === transport,
  sameExecuteReference: entry.transport.execute === originalExecute,
  descriptor: descriptor === undefined ? null : {
    writable: descriptor.writable,
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
  },
  swapRejected,
  first,
  second,
  third,
  calls: transport.calls,
  tags: transport.tags,
  prototypeHijackCalls,
  transportFrozen: Object.isFrozen(transport),
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


class FactoryRunnerBrowserRemoteTransportSealTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_registered_entry_keeps_original_execute_reference_after_method_swap(self):
        self.assertTrue(self.observed["sameTransportObject"])
        self.assertTrue(self.observed["sameExecuteReference"])
        self.assertTrue(self.observed["swapRejected"])
        self.assertEqual(self.observed["first"], {"source": "original", "calls": 1})
        self.assertEqual(self.observed["second"], {"source": "original", "calls": 2})
        self.assertEqual(self.observed["third"], {"source": "original", "calls": 3})
        self.assertEqual(self.observed["prototypeHijackCalls"], 0)

    def test_sealed_transport_preserves_internal_state_without_exposing_mutable_execute_authority(self):
        descriptor = self.observed["descriptor"]
        self.assertIsNotNone(descriptor)
        self.assertFalse(descriptor["writable"])
        self.assertFalse(descriptor["configurable"])
        self.assertFalse(self.observed["transportFrozen"])
        self.assertEqual(self.observed["calls"], 3)
        self.assertEqual(
            self.observed["tags"],
            ["first", "external-state-still-mutable", "second", "third"],
        )


if __name__ == "__main__":
    unittest.main()
