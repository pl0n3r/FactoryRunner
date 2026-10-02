"""Aceptación del registry atómico de pins browser remotos (#230)."""
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
import { BrowserRemotePinRegistry } from './src/browser-remote-pin-registry.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const REQUEST = 'a'.repeat(64);

class Transport {
  async execute(request) {
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:pin-registry-0230',
    };
  }
}

const directory = new BrowserRemoteDirectory();
const entry = directory.register({
  profile: browserRemoteProfile({
    version: 1,
    runner_id: '11111111-1111-7111-8111-111111111111',
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
  }),
  transport: new Transport(),
});
const handle = browserRemoteEntryHandle(entry);
const directoryEntries = directory.entries;

const atomic = new BrowserRemotePinRegistry();
const pinned = atomic.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});
const peek = atomic.peek(REQUEST);
const sizeBeforeTake = atomic.size;
const taken = atomic.take(REQUEST);
const sizeAfterTake = atomic.size;
const secondTake = atomic.take(REQUEST);

const drift = new BrowserRemotePinRegistry();
const original = drift.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});
const idempotent = drift.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});

function rejects(candidate) {
  try {
    drift.pin(REQUEST, candidate);
    return false;
  } catch {
    return true;
  }
}

const bindingDrift = rejects({
  binding_fingerprint: 'f'.repeat(64),
  handle,
  directory_entries: directoryEntries,
});
const handleDrift = rejects({
  binding_fingerprint: handle.binding_fingerprint,
  handle: browserRemoteEntryHandle(entry),
  directory_entries: directoryEntries,
});
const directoryDrift = rejects({
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: () => directory.entries(),
});
const sizeBeforeDrop = drift.size;
drift.drop(REQUEST);
drift.drop(REQUEST);

console.log(JSON.stringify({
  atomic: {
    pinnedIsPeek: pinned === peek,
    pinnedIsTaken: pinned === taken,
    handleExact: taken?.handle === handle,
    directoryExact: taken?.directory_entries === directoryEntries,
    sizeBeforeTake,
    sizeAfterTake,
    secondTake,
  },
  drift: {
    idempotentExact: original === idempotent,
    bindingDrift,
    handleDrift,
    directoryDrift,
    sizeBeforeDrop,
    sizeAfterDrop: drift.size,
    peekAfterDrop: drift.peek(REQUEST),
  },
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


class FactoryRunnerBrowserRemotePinRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_registry_take_is_atomic_and_second_take_returns_no_handle(self):
        self.assertEqual(
            self.observed["atomic"],
            {
                "pinnedIsPeek": True,
                "pinnedIsTaken": True,
                "handleExact": True,
                "directoryExact": True,
                "sizeBeforeTake": 1,
                "sizeAfterTake": 0,
                "secondTake": None,
            },
        )

    def test_registry_rejects_drift_on_existing_fingerprint_and_drop_is_idempotent(self):
        self.assertEqual(
            self.observed["drift"],
            {
                "idempotentExact": True,
                "bindingDrift": True,
                "handleDrift": True,
                "directoryDrift": True,
                "sizeBeforeDrop": 1,
                "sizeAfterDrop": 0,
                "peekAfterDrop": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
