"""Aceptación del retiro exacto del directorio browser remoto (#245)."""
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

let transportCalls = 0;
const transport = {
  async execute() {
    transportCalls += 1;
    throw new Error('transport must not run during directory operations');
  },
};

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const directory = new BrowserRemoteDirectory();
const initialSize = directory.size;
directory.register({ profile, transport });
const sizeAfterRegister = directory.size;
const removed = directory.remove('browser-primary', profile.fingerprint);
const sizeAfterRemove = directory.size;
const lookupAfterRemove = directory.lookup('browser-primary');
const removedAgain = directory.remove('browser-primary', profile.fingerprint);
const sizeAfterIdempotentRemove = directory.size;

const guarded = new BrowserRemoteDirectory();
guarded.register({ profile, transport });
const driftRejected = rejected(() => {
  guarded.remove('browser-primary', '0'.repeat(64));
});
const invalidFingerprintRejected = rejected(() => {
  guarded.remove('browser-primary', 'not-a-fingerprint');
});

console.log(JSON.stringify({
  initialSize,
  sizeAfterRegister,
  removed,
  sizeAfterRemove,
  lookupAfterRemove,
  removedAgain,
  sizeAfterIdempotentRemove,
  driftRejected,
  invalidFingerprintRejected,
  guardedSize: guarded.size,
  guardedAlias: guarded.lookup('browser-primary')?.profile.remote_alias ?? null,
  transportCalls,
}));
"""
    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteDirectoryRemoveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_remove_exact_alias_and_fingerprint_is_idempotent_and_updates_size(self):
        self.assertEqual(self.observed["initialSize"], 0)
        self.assertEqual(self.observed["sizeAfterRegister"], 1)
        self.assertTrue(self.observed["removed"])
        self.assertEqual(self.observed["sizeAfterRemove"], 0)
        self.assertIsNone(self.observed["lookupAfterRemove"])
        self.assertFalse(self.observed["removedAgain"])
        self.assertEqual(self.observed["sizeAfterIdempotentRemove"], 0)
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_remove_rejects_fingerprint_drift_without_transport_calls(self):
        self.assertTrue(self.observed["driftRejected"])
        self.assertTrue(self.observed["invalidFingerprintRejected"])
        self.assertEqual(self.observed["guardedSize"], 1)
        self.assertEqual(self.observed["guardedAlias"], "browser-primary")
        self.assertEqual(self.observed["transportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
