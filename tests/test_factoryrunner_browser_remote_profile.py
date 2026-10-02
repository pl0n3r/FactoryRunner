"""Aceptación del perfil browser remoto provider-neutral (#162)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const input = {
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
};

const profile = browserRemoteProfile(input);

function rejected(candidate) {
  try {
    browserRemoteProfile(candidate);
    return false;
  } catch {
    return true;
  }
}

const sensitive = {
  endpoint: 'https://remote.example.test/session',
  url: 'https://remote.example.test/session',
  provider: 'vendor-specific',
  token: 'token=do-not-accept',
  credential: 'password=do-not-accept',
  credentials: { username: 'user', password: 'secret' },
  cookie: 'session=secret',
  headers: { authorization: 'Bearer secret-value' },
  storage: { localStorage: { token: 'secret' } },
  websocket_url: 'wss://remote.example.test/devtools',
};

const sensitiveRejected = Object.fromEntries(
  Object.entries(sensitive).map(([key, value]) => [
    key,
    rejected({ ...input, [key]: value }),
  ]),
);

const aliasesRejected = [
  'https://remote.example.test',
  'remote.example.test',
  'user@remote',
  'remote/profile',
  'remote:profile',
  'UPPERCASE',
  '',
].map((remote_alias) => rejected({ ...input, remote_alias }));

const capabilityRejected = rejected({
  ...input,
  capability: 'browser.remote.admin',
});

console.log(JSON.stringify({
  profile,
  frozen: Object.isFrozen(profile),
  keys: Object.keys(profile).sort(),
  sensitiveRejected,
  aliasesRejected,
  capabilityRejected,
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


class FactoryRunnerBrowserRemoteProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_profile_is_opaque_secret_free_and_provider_neutral(self):
        profile = self.observed["profile"]
        self.assertEqual(profile["version"], 1)
        self.assertEqual(profile["authority"], "unchanged")
        self.assertEqual(
            profile["runner_id"],
            "11111111-1111-7111-8111-111111111111",
        )
        self.assertEqual(profile["location"], "hostinger-shared")
        self.assertEqual(profile["capability"], "browser.navigate")
        self.assertEqual(profile["remote_alias"], "browser-primary")
        self.assertRegex(profile["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"])
        self.assertEqual(
            self.observed["keys"],
            [
                "authority",
                "capability",
                "fingerprint",
                "location",
                "remote_alias",
                "runner_id",
                "version",
            ],
        )
        serialized = json.dumps(profile).lower()
        for forbidden in (
            "endpoint",
            "provider",
            "credential",
            "cookie",
            "header",
            "storage",
            "http://",
            "https://",
            "wss://",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

    def test_sensitive_endpoint_or_credential_fields_are_rejected(self):
        for key, rejected in self.observed["sensitiveRejected"].items():
            with self.subTest(field=key):
                self.assertTrue(rejected)
        self.assertTrue(all(self.observed["aliasesRejected"]))
        self.assertTrue(self.observed["capabilityRejected"])


if __name__ == "__main__":
    unittest.main()
