"""Aceptación del directorio browser remoto in-memory (#173)."""
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

const baseInput = {
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
};

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

const profile = browserRemoteProfile(baseInput);
const directory = new BrowserRemoteDirectory();
const registered = directory.register({ profile, transport });
const found = directory.lookup('browser-primary');
const missing = directory.lookup('browser-secondary');
const entries = directory.entries();

const duplicateRejected = rejected(() => {
  directory.register({ profile, transport });
});

const tamperedFingerprintRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, fingerprint: '0'.repeat(64) },
    transport,
  });
});

const tamperedAuthorityRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, authority: 'expanded' },
    transport,
  });
});

const extraProfileFieldRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, endpoint: 'https://remote.example.test' },
    transport,
  });
});

const invalidTransportRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({ profile, transport: {} });
});

const invalidLookupAliasRejected = rejected(() => {
  directory.lookup('https://remote.example.test');
});

console.log(JSON.stringify({
  registeredAlias: registered.profile.remote_alias,
  foundAlias: found?.profile.remote_alias ?? null,
  foundUsesSameTransport: found?.transport === transport,
  missing,
  entryCount: entries.length,
  entriesFrozen: Object.isFrozen(entries),
  entryFrozen: Object.isFrozen(registered),
  profileFrozen: Object.isFrozen(registered.profile),
  transportCalls,
  duplicateRejected,
  tamperedFingerprintRejected,
  tamperedAuthorityRejected,
  extraProfileFieldRejected,
  invalidTransportRejected,
  invalidLookupAliasRejected,
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


class FactoryRunnerBrowserRemoteDirectoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_directory_registers_canonical_profiles_by_opaque_alias_without_transport_calls(self):
        self.assertEqual(self.observed["registeredAlias"], "browser-primary")
        self.assertEqual(self.observed["foundAlias"], "browser-primary")
        self.assertTrue(self.observed["foundUsesSameTransport"])
        self.assertIsNone(self.observed["missing"])
        self.assertEqual(self.observed["entryCount"], 1)
        self.assertTrue(self.observed["entriesFrozen"])
        self.assertTrue(self.observed["entryFrozen"])
        self.assertTrue(self.observed["profileFrozen"])
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_duplicate_or_tampered_profiles_fail_closed(self):
        self.assertTrue(self.observed["duplicateRejected"])
        self.assertTrue(self.observed["tamperedFingerprintRejected"])
        self.assertTrue(self.observed["tamperedAuthorityRejected"])
        self.assertTrue(self.observed["extraProfileFieldRejected"])
        self.assertTrue(self.observed["invalidTransportRejected"])
        self.assertTrue(self.observed["invalidLookupAliasRejected"])
        self.assertEqual(self.observed["transportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
