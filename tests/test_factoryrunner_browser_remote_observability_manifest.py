import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = [
    "browserRemoteDirectoryDoctor",
    "browserRemoteDirectoryHealth",
    "browserRemoteDirectoryHealthBundle",
    "browserRemoteDirectoryMetrics",
    "browserRemoteDirectoryReadiness",
    "browserRemoteDirectorySnapshot",
]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteObservabilityManifest } from './src/browser-remote-observability-manifest.ts';

const first = browserRemoteObservabilityManifest();
const second = browserRemoteObservabilityManifest();
const serialized = JSON.stringify(first);

console.log(JSON.stringify({
  first,
  second,
  frozen: Object.isFrozen(first),
  exportsFrozen: Object.isFrozen(first.exports),
  entriesFrozen: first.exports.every((entry) => Object.isFrozen(entry)),
  containsPath: serialized.includes('./') || serialized.includes('.ts'),
  containsProvider: serialized.toLowerCase().includes('provider'),
  containsEndpoint: serialized.includes('http://') || serialized.includes('https://'),
  containsTransport: serialized.toLowerCase().includes('transport'),
  containsSecret: serialized.toLowerCase().includes('secret'),
  containsAlias: serialized.toLowerCase().includes('alias'),
  containsLocation: serialized.toLowerCase().includes('hostinger'),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_manifest_is_sorted_versioned_and_fingerprinted(self):
        first = self.observed["first"]
        self.assertEqual(first["version"], 1)
        self.assertEqual(first["authority"], "unchanged")
        self.assertEqual(
            [entry["export_name"] for entry in first["exports"]],
            EXPECTED,
        )
        self.assertTrue(
            all(entry["contract_version"] == 1 for entry in first["exports"])
        )
        self.assertRegex(first["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            first["fingerprint"],
            self.observed["second"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["exportsFrozen"])
        self.assertTrue(self.observed["entriesFrozen"])

    def test_manifest_contains_only_public_sanitized_contracts(self):
        names = {entry["export_name"] for entry in self.observed["first"]["exports"]}
        self.assertEqual(names, set(EXPECTED))
        self.assertTrue(
            names.isdisjoint(
                {
                    "BrowserRemoteDirectory",
                    "BrowserRemoteDriver",
                    "createBrowserRemoteSupervisor",
                    "browserRemoteProfile",
                }
            )
        )
        for key in (
            "containsPath",
            "containsProvider",
            "containsEndpoint",
            "containsTransport",
            "containsSecret",
            "containsAlias",
            "containsLocation",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])


if __name__ == "__main__":
    unittest.main()
