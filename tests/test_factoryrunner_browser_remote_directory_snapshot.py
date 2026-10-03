"""Aceptación del snapshot sanitizado del directorio browser remoto (#256)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteDirectorySnapshot } from './src/browser-remote-directory-snapshot.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

function profile(runnerId, alias) {
  return browserRemoteProfile({
    version: 1,
    runner_id: runnerId,
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: alias,
  });
}

function transport(name) {
  return {
    endpoint: `https://example.invalid/${name}`,
    headers: { authorization: 'sentinel-auth' },
    cookies: 'sentinel-cookie',
    async execute() {
      throw new Error('transport must not run during snapshot');
    },
  };
}

const alpha = profile('11111111-1111-7111-8111-111111111111', 'browser-alpha');
const beta = profile('22222222-2222-7222-8222-222222222222', 'browser-beta');
const gamma = profile('33333333-3333-7333-8333-333333333333', 'browser-gamma');

function snapshotFor(entries) {
  const directory = new BrowserRemoteDirectory();
  for (const entry of entries) {
    directory.register(entry);
  }
  return { directory, snapshot: browserRemoteDirectorySnapshot(directory) };
}

const first = snapshotFor([
  { profile: beta, transport: transport('beta') },
  { profile: alpha, transport: transport('alpha') },
]);
const second = snapshotFor([
  { profile: alpha, transport: transport('alpha-2') },
  { profile: beta, transport: transport('beta-2') },
]);

const beforeChange = first.snapshot.fingerprint;
first.directory.remove('browser-beta', beta.fingerprint);
const afterRemove = browserRemoteDirectorySnapshot(first.directory);
first.directory.register({ profile: gamma, transport: transport('gamma') });
const afterRegister = browserRemoteDirectorySnapshot(first.directory);
first.directory.rotate(
  'browser-alpha',
  alpha.fingerprint,
  {
    profile: profile('44444444-4444-7444-8444-444444444444', 'browser-alpha'),
    transport: transport('alpha-rotated'),
  },
);
const afterRotate = browserRemoteDirectorySnapshot(first.directory);

const serialized = JSON.stringify(second.snapshot);

console.log(JSON.stringify({
  version: second.snapshot.version,
  authority: second.snapshot.authority,
  size: second.snapshot.size,
  aliases: second.snapshot.profiles.map((item) => item.remote_alias),
  fingerprintA: beforeChange,
  fingerprintB: second.snapshot.fingerprint,
  removeFingerprint: afterRemove.fingerprint,
  registerFingerprint: afterRegister.fingerprint,
  rotateFingerprint: afterRotate.fingerprint,
  snapshotFrozen: Object.isFrozen(second.snapshot),
  profilesFrozen: Object.isFrozen(second.snapshot.profiles),
  entriesFrozen: second.snapshot.profiles.every((item) => Object.isFrozen(item)),
  hasTransport: 'transport' in second.snapshot || second.snapshot.profiles.some((item) => 'transport' in item),
  hasExecute: serialized.includes('execute'),
  hasEndpoint: serialized.includes('example.invalid'),
  hasHeaders: serialized.includes('headers'),
  hasCookies: serialized.includes('sentinel-cookie'),
  invalidDirectoryRejected: (() => {
    try {
      browserRemoteDirectorySnapshot({ entries() { return []; } });
      return false;
    } catch {
      return true;
    }
  })(),
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


class FactoryRunnerBrowserRemoteDirectorySnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_snapshot_is_sorted_stable_and_excludes_transport(self):
        self.assertEqual(self.observed["version"], 1)
        self.assertEqual(self.observed["authority"], "unchanged")
        self.assertEqual(self.observed["size"], 2)
        self.assertEqual(
            self.observed["aliases"],
            ["browser-alpha", "browser-beta"],
        )
        self.assertTrue(self.observed["snapshotFrozen"])
        self.assertTrue(self.observed["profilesFrozen"])
        self.assertTrue(self.observed["entriesFrozen"])
        self.assertFalse(self.observed["hasTransport"])
        self.assertFalse(self.observed["hasExecute"])
        self.assertFalse(self.observed["hasEndpoint"])
        self.assertFalse(self.observed["hasHeaders"])
        self.assertFalse(self.observed["hasCookies"])
        self.assertTrue(self.observed["invalidDirectoryRejected"])

    def test_snapshot_fingerprint_changes_when_profiles_change_not_registration_order(self):
        self.assertEqual(
            self.observed["fingerprintA"],
            self.observed["fingerprintB"],
        )
        self.assertNotEqual(
            self.observed["fingerprintA"],
            self.observed["removeFingerprint"],
        )
        self.assertNotEqual(
            self.observed["removeFingerprint"],
            self.observed["registerFingerprint"],
        )
        self.assertNotEqual(
            self.observed["registerFingerprint"],
            self.observed["rotateFingerprint"],
        )


if __name__ == "__main__":
    unittest.main()
