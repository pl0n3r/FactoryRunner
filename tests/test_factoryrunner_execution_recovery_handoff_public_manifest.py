import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = [
    "executionRecoveryHandoffManifest",
    "executionRecoveryHandoffManifestPreview",
    "executionRecoveryHandoffManifestVerify",
    "executionRecoveryHandoffPacket",
    "executionRecoveryHandoffPreview",
    "executionRecoveryHandoffVerify",
]


def observe() -> dict[str, object]:
    script = r"""
import { executionRecoveryHandoffPublicManifest } from './src/execution-recovery-handoff-public-manifest.ts';

const first = executionRecoveryHandoffPublicManifest();
const second = executionRecoveryHandoffPublicManifest();
const serialized = JSON.stringify(first);
const lowered = serialized.toLowerCase();

console.log(JSON.stringify({
  first,
  second,
  frozen: Object.isFrozen(first),
  exportsFrozen: Object.isFrozen(first.exports),
  entriesFrozen: first.exports.every((entry) => Object.isFrozen(entry)),
  containsPath: serialized.includes('./') || serialized.includes('.ts'),
  containsProvider: lowered.includes('provider'),
  containsEndpoint: serialized.includes('http://') || serialized.includes('https://'),
  containsTransport: lowered.includes('transport'),
  containsSecret: lowered.includes('secret'),
  containsCredential: lowered.includes('credential'),
  containsToken: lowered.includes('token'),
  containsAlias: lowered.includes('alias'),
  containsPayload: lowered.includes('payload'),
  containsExecutionId: lowered.includes('execution_id'),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerExecutionRecoveryHandoffPublicManifestTests(unittest.TestCase):
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
        self.assertEqual(EXPECTED, sorted(EXPECTED))
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

    def test_manifest_contains_only_sanitized_public_contract_metadata_without_authority(self):
        first = self.observed["first"]
        names = {entry["export_name"] for entry in first["exports"]}
        self.assertEqual(names, set(EXPECTED))
        self.assertEqual(first["authority"], "unchanged")
        self.assertFalse(first["execution"])
        self.assertFalse(first["network_access"])
        self.assertFalse(first["external_mutation"])

        for key in (
            "containsPath",
            "containsProvider",
            "containsEndpoint",
            "containsTransport",
            "containsSecret",
            "containsCredential",
            "containsToken",
            "containsAlias",
            "containsPayload",
            "containsExecutionId",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])


if __name__ == "__main__":
    unittest.main()
