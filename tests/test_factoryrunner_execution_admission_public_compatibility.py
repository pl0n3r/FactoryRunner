import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_SOURCE = (ROOT / "src/execution-admission-public-manifest.ts").read_text(
    encoding="utf-8"
)
COMPAT_SOURCE = (ROOT / "src/execution-admission-public-compatibility.ts").read_text(
    encoding="utf-8"
)
EXPECTED_EXPORTS = [
    "executionAdmissionDecision",
    "ExecutionAdmissionDecision",
    "ExecutionAdmissionState",
    "admissionEvidence",
    "AdmissionEvidence",
]
ALLOWED_REASONS = {
    "CONTRACT_MISSING",
    "MANIFEST_INVALID",
    "REQUIREMENTS_INVALID",
    "VERSION_MISMATCH",
}


def observe() -> dict[str, object]:
    script = r"""
import { executionAdmissionPublicManifest } from './src/execution-admission-public-manifest.ts';
import { executionAdmissionPublicCompatibility } from './src/execution-admission-public-compatibility.ts';

const manifest = executionAdmissionPublicManifest();
const requirements = manifest.exports.map((entry) => ({
  export_name: entry.export_name,
  contract_version: entry.contract_version,
}));
const exact = executionAdmissionPublicCompatibility(manifest, requirements);
const exactAgain = executionAdmissionPublicCompatibility(manifest, requirements);

const unknownRequirement = executionAdmissionPublicCompatibility(
  manifest,
  [...requirements, { export_name: 'executionAdmissionUnknown', contract_version: 1 }],
);
const versionMismatch = executionAdmissionPublicCompatibility(
  manifest,
  requirements.map((entry, index) => index === 0 ? { ...entry, contract_version: 2 } : entry),
);
const malformedRequirement = executionAdmissionPublicCompatibility(
  manifest,
  requirements.map((entry, index) => index === 0 ? { ...entry, unexpected: true } : entry),
);
const duplicateRequirement = executionAdmissionPublicCompatibility(
  manifest,
  [requirements[0], requirements[0]],
);
const missingManifestExport = executionAdmissionPublicCompatibility(
  { ...manifest, exports: manifest.exports.slice(0, -1) },
  requirements,
);
const authorityDrift = executionAdmissionPublicCompatibility(
  { ...manifest, authority: 'expanded' },
  requirements,
);
const extraManifestField = executionAdmissionPublicCompatibility(
  { ...manifest, transport: 'http' },
  requirements,
);
const invalidManifestVersion = executionAdmissionPublicCompatibility(
  { ...manifest, version: 2 },
  requirements,
);

console.log(JSON.stringify({
  manifest,
  manifestFrozen: Object.isFrozen(manifest),
  exportsFrozen: Object.isFrozen(manifest.exports),
  exact,
  exactAgain,
  exactFrozen: Object.isFrozen(exact),
  reasonsFrozen: Object.isFrozen(exact.reasons),
  invalid: {
    unknownRequirement,
    versionMismatch,
    malformedRequirement,
    duplicateRequirement,
    missingManifestExport,
    authorityDrift,
    extraManifestField,
    invalidManifestVersion,
  },
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerExecutionAdmissionPublicCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_manifest_is_closed_versioned_and_authority_unchanged(self):
        manifest = self.observed["manifest"]
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["authority"], "unchanged")
        self.assertEqual(
            [entry["export_name"] for entry in manifest["exports"]],
            EXPECTED_EXPORTS,
        )
        self.assertTrue(all(entry["contract_version"] == 1 for entry in manifest["exports"]))
        self.assertFalse(manifest["execution"])
        self.assertFalse(manifest["network_access"])
        self.assertFalse(manifest["external_mutation"])
        self.assertRegex(manifest["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["manifestFrozen"])
        self.assertTrue(self.observed["exportsFrozen"])

    def test_exact_public_requirement_is_compatible_and_deterministic(self):
        exact = self.observed["exact"]
        manifest = self.observed["manifest"]
        self.assertEqual(exact["version"], 1)
        self.assertEqual(exact["authority"], "unchanged")
        self.assertEqual(exact["status"], "COMPATIBLE")
        self.assertEqual(exact["reasons"], [])
        self.assertEqual(exact["manifest_fingerprint"], manifest["fingerprint"])
        self.assertFalse(exact["execution"])
        self.assertFalse(exact["network_access"])
        self.assertFalse(exact["external_mutation"])
        self.assertRegex(exact["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(exact, self.observed["exactAgain"])
        self.assertTrue(self.observed["exactFrozen"])
        self.assertTrue(self.observed["reasonsFrozen"])

    def test_missing_unknown_extra_version_or_authority_drift_fails_closed(self):
        expected = {
            "unknownRequirement": ["CONTRACT_MISSING"],
            "versionMismatch": ["VERSION_MISMATCH"],
            "malformedRequirement": ["REQUIREMENTS_INVALID"],
            "duplicateRequirement": ["REQUIREMENTS_INVALID"],
            "missingManifestExport": ["MANIFEST_INVALID"],
            "authorityDrift": ["MANIFEST_INVALID"],
            "extraManifestField": ["MANIFEST_INVALID"],
            "invalidManifestVersion": ["MANIFEST_INVALID"],
        }
        for name, reasons in expected.items():
            with self.subTest(name=name):
                result = self.observed["invalid"][name]
                self.assertEqual(result["status"], "INCOMPATIBLE")
                self.assertEqual(result["reasons"], reasons)
                self.assertTrue(set(result["reasons"]).issubset(ALLOWED_REASONS))
                self.assertEqual(result["authority"], "unchanged")
                self.assertFalse(result["execution"])
                self.assertFalse(result["network_access"])
                self.assertFalse(result["external_mutation"])

    def test_compatibility_output_is_secret_free_and_has_no_execution_authority(self):
        exact = self.observed["exact"]
        serialized = json.dumps(exact, sort_keys=True).lower()
        for forbidden in (
            "payload",
            "instruction_ref",
            "adapter",
            "capabilit",
            "secret",
            "transport",
            "credential",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

        source = MANIFEST_SOURCE + "\n" + COMPAT_SOURCE
        for forbidden in (
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
            "fetch(",
            "process.",
            "Deno.",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
