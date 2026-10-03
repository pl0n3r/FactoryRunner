"""Aceptación de rotación atómica del directorio browser remoto (#246)."""
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

function profile(runnerId, alias = 'browser-primary') {
  return browserRemoteProfile({
    version: 1,
    runner_id: runnerId,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: alias,
  });
}

let transportCalls = 0;
function transport(name) {
  return {
    name,
    async execute() {
      transportCalls += 1;
      throw new Error('transport must not run during directory rotation');
    },
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

const initial = profile('11111111-1111-7111-8111-111111111111');
const replacement = profile('22222222-2222-7222-8222-222222222222');
const initialTransport = transport('initial');
const replacementTransport = transport('replacement');

const directory = new BrowserRemoteDirectory();
directory.register({ profile: initial, transport: initialTransport });
const sizeBeforeRotate = directory.size;
const rotated = directory.rotate(
  'browser-primary',
  initial.fingerprint,
  { profile: replacement, transport: replacementTransport },
);
const current = directory.lookup('browser-primary');

const guarded = new BrowserRemoteDirectory();
guarded.register({ profile: initial, transport: transport('guarded') });

const staleRejected = rejected(() => {
  guarded.rotate(
    'browser-primary',
    '0'.repeat(64),
    { profile: replacement, transport: transport('stale') },
  );
});

const missingRejected = rejected(() => {
  guarded.rotate(
    'browser-missing',
    initial.fingerprint,
    { profile: profile('33333333-3333-7333-8333-333333333333', 'browser-missing'), transport: transport('missing') },
  );
});

const aliasMismatchRejected = rejected(() => {
  guarded.rotate(
    'browser-primary',
    initial.fingerprint,
    { profile: profile('44444444-4444-7444-8444-444444444444', 'browser-other'), transport: transport('alias-mismatch') },
  );
});

const malformedProfile = {
  ...replacement,
  fingerprint: 'f'.repeat(64),
};
const invalidProfileRejected = rejected(() => {
  guarded.rotate(
    'browser-primary',
    initial.fingerprint,
    { profile: malformedProfile, transport: transport('invalid-profile') },
  );
});

const invalidTransportRejected = rejected(() => {
  guarded.rotate(
    'browser-primary',
    initial.fingerprint,
    { profile: replacement, transport: { execute: 'not-a-function' } },
  );
});

const guardedCurrent = guarded.lookup('browser-primary');

console.log(JSON.stringify({
  sizeBeforeRotate,
  sizeAfterRotate: directory.size,
  rotatedFingerprint: rotated.profile.fingerprint,
  currentFingerprint: current?.profile.fingerprint ?? null,
  currentAlias: current?.profile.remote_alias ?? null,
  usesReplacementTransport: current?.transport === replacementTransport,
  staleRejected,
  missingRejected,
  aliasMismatchRejected,
  invalidProfileRejected,
  invalidTransportRejected,
  guardedSize: guarded.size,
  guardedFingerprint: guardedCurrent?.profile.fingerprint ?? null,
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


class FactoryRunnerBrowserRemoteDirectoryRotateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_rotate_replaces_same_alias_atomically_without_growing_directory(self):
        self.assertEqual(self.observed["sizeBeforeRotate"], 1)
        self.assertEqual(self.observed["sizeAfterRotate"], 1)
        self.assertEqual(self.observed["currentAlias"], "browser-primary")
        self.assertEqual(
            self.observed["rotatedFingerprint"],
            self.observed["currentFingerprint"],
        )
        self.assertTrue(self.observed["usesReplacementTransport"])
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_rotate_rejects_stale_fingerprint_and_invalid_replacement_fail_closed(self):
        self.assertTrue(self.observed["staleRejected"])
        self.assertTrue(self.observed["missingRejected"])
        self.assertTrue(self.observed["aliasMismatchRejected"])
        self.assertTrue(self.observed["invalidProfileRejected"])
        self.assertTrue(self.observed["invalidTransportRejected"])
        self.assertEqual(self.observed["guardedSize"], 1)
        self.assertIsNotNone(self.observed["guardedFingerprint"])
        self.assertEqual(self.observed["transportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
