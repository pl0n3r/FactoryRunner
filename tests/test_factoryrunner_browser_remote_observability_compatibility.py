import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteObservabilityCompatibility } from './src/browser-remote-observability-compatibility.ts';
import { browserRemoteObservabilityManifest } from './src/browser-remote-observability-manifest.ts';

const manifest = browserRemoteObservabilityManifest();
const supported = {
  version: 1,
  manifest_version: 1,
  required_exports: [
    { export_name: 'browserRemoteDirectoryHealth', contract_version: 1 },
    { export_name: 'browserRemoteDirectorySnapshot', contract_version: 1 },
  ],
};

const cases = {
  compatible: browserRemoteObservabilityCompatibility(manifest, supported),
  repeated: browserRemoteObservabilityCompatibility(manifest, supported),
  unknownExport: browserRemoteObservabilityCompatibility(manifest, {
    ...supported,
    required_exports: [{ export_name: 'browserRemoteDirectoryUnknown', contract_version: 1 }],
  }),
  unknownVersion: browserRemoteObservabilityCompatibility(manifest, {
    ...supported,
    required_exports: [{ export_name: 'browserRemoteDirectoryHealth', contract_version: 2 }],
  }),
  unknownManifestVersion: browserRemoteObservabilityCompatibility(manifest, {
    ...supported,
    manifest_version: 2,
  }),
  extraConsumerField: browserRemoteObservabilityCompatibility(manifest, {
    ...supported,
    unexpected: true,
  }),
  tamperedManifest: browserRemoteObservabilityCompatibility({
    ...manifest,
    fingerprint: '0'.repeat(64),
  }, supported),
};

console.log(JSON.stringify({
  manifest,
  cases,
  compatibleFrozen: Object.isFrozen(cases.compatible),
  reasonsFrozen: Object.isFrozen(cases.compatible.reasons),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supported_consumer_contract_is_compatible_with_manifest_fingerprint(self):
        item = self.observed["cases"]["compatible"]
        manifest = self.observed["manifest"]

        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "COMPATIBLE")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(item["manifest_fingerprint"], manifest["fingerprint"])
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])
        self.assertRegex(item["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            item["fingerprint"],
            self.observed["cases"]["repeated"]["fingerprint"],
        )
        self.assertTrue(self.observed["compatibleFrozen"])
        self.assertTrue(self.observed["reasonsFrozen"])

    def test_unknown_export_version_or_tampered_manifest_fails_closed(self):
        cases = self.observed["cases"]
        expected = {
            "unknownExport": "EXPORT_UNSUPPORTED",
            "unknownVersion": "EXPORT_VERSION_UNSUPPORTED",
            "unknownManifestVersion": "MANIFEST_VERSION_UNSUPPORTED",
            "extraConsumerField": "CONSUMER_INVALID",
            "tamperedManifest": "MANIFEST_INVALID",
        }

        for name, reason in expected.items():
            with self.subTest(case=name):
                item = cases[name]
                self.assertEqual(item["status"], "INCOMPATIBLE")
                self.assertIn(reason, item["reasons"])
                self.assertFalse(item["network_access"])
                self.assertFalse(item["external_mutation"])

        self.assertIsNone(cases["tamperedManifest"]["manifest_fingerprint"])


if __name__ == "__main__":
    unittest.main()
