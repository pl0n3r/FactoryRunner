import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_EXPORTS = [
    "executionAdmissionDecision",
    "ExecutionAdmissionDecision",
    "ExecutionAdmissionState",
    "admissionEvidence",
    "AdmissionEvidence",
]
EXPECTED_FAILURES = {
    "unknown": ["CONTRACT_MISSING"],
    "version": ["VERSION_MISMATCH"],
    "requirement_shape": ["REQUIREMENTS_INVALID"],
    "duplicate": ["REQUIREMENTS_INVALID"],
    "missing_export": ["MANIFEST_INVALID"],
    "authority": ["MANIFEST_INVALID"],
    "manifest_shape": ["MANIFEST_INVALID"],
    "manifest_version": ["MANIFEST_INVALID"],
}


def observe() -> dict[str, object]:
    script = r"""
const manifestModule = await import('./src/execution-admission-public-manifest.ts');
const compatibilityModule = await import('./src/execution-admission-public-compatibility.ts');
const manifest = manifestModule.executionAdmissionPublicManifest();
const requirements = manifest.exports.map(({ export_name, contract_version }) => ({
  export_name,
  contract_version,
}));
const check = (candidateManifest, candidateRequirements) =>
  compatibilityModule.executionAdmissionPublicCompatibility(candidateManifest, candidateRequirements);
const first = requirements[0];
const cases = [
  ['unknown', manifest, requirements.concat({ export_name: 'executionAdmissionUnknown', contract_version: 1 })],
  ['version', manifest, requirements.map((item, index) => index ? item : { ...item, contract_version: 2 })],
  ['requirement_shape', manifest, requirements.map((item, index) => index ? item : { ...item, unexpected: true })],
  ['duplicate', manifest, [first, first]],
  ['missing_export', { ...manifest, exports: manifest.exports.slice(0, -1) }, requirements],
  ['authority', { ...manifest, authority: 'expanded' }, requirements],
  ['manifest_shape', { ...manifest, transport: 'http' }, requirements],
  ['manifest_version', { ...manifest, version: 2 }, requirements],
];
const invalid = Object.fromEntries(cases.map(([name, candidateManifest, candidateRequirements]) => [
  name,
  check(candidateManifest, candidateRequirements),
]));
const exact = check(manifest, requirements);
console.log(JSON.stringify({
  manifest,
  exact,
  exactAgain: check(manifest, requirements),
  invalid,
  frozen: {
    manifest: Object.isFrozen(manifest),
    exports: Object.isFrozen(manifest.exports),
    exact: Object.isFrozen(exact),
    reasons: Object.isFrozen(exact.reasons),
  },
}));
"""
    output = subprocess.check_output(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(output.rsplit("\n", 2)[-2])


class FactoryRunnerExecutionAdmissionPublicCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def assert_safe_envelope(self, value: dict[str, object]) -> None:
        self.assertEqual(value["authority"], "unchanged")
        self.assertFalse(value["execution"])
        self.assertFalse(value["network_access"])
        self.assertFalse(value["external_mutation"])

    def test_manifest_is_closed_versioned_and_authority_unchanged(self):
        manifest = self.observed["manifest"]
        self.assertEqual(manifest["version"], 1)
        self.assertEqual([item["export_name"] for item in manifest["exports"]], EXPECTED_EXPORTS)
        self.assertEqual({item["contract_version"] for item in manifest["exports"]}, {1})
        self.assertRegex(manifest["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"]["manifest"])
        self.assertTrue(self.observed["frozen"]["exports"])
        self.assert_safe_envelope(manifest)

    def test_exact_public_requirement_is_compatible_and_deterministic(self):
        exact = self.observed["exact"]
        self.assertEqual(exact, self.observed["exactAgain"])
        self.assertEqual(exact["status"], "COMPATIBLE")
        self.assertEqual(exact["reasons"], [])
        self.assertEqual(exact["manifest_fingerprint"], self.observed["manifest"]["fingerprint"])
        self.assertTrue(self.observed["frozen"]["exact"])
        self.assertTrue(self.observed["frozen"]["reasons"])
        self.assert_safe_envelope(exact)

    def test_missing_unknown_extra_version_or_authority_drift_fails_closed(self):
        for name, expected_reasons in EXPECTED_FAILURES.items():
            with self.subTest(case=name):
                result = self.observed["invalid"][name]
                self.assertEqual(result["status"], "INCOMPATIBLE")
                self.assertEqual(result["reasons"], expected_reasons)
                self.assert_safe_envelope(result)

    def test_compatibility_output_is_secret_free_and_has_no_execution_authority(self):
        serialized = json.dumps(self.observed, sort_keys=True).lower()
        for forbidden in ("payload", "instruction_ref", "adapter", "capabilit", "secret", "credential"):
            self.assertNotIn(forbidden, serialized)

        source = "\n".join(
            (ROOT / path).read_text(encoding="utf-8")
            for path in (
                "src/execution-admission-public-manifest.ts",
                "src/execution-admission-public-compatibility.ts",
            )
        )
        for forbidden in ("node:fs", "node:http", "node:https", "node:child_process", "fetch(", "process.", "Deno."):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
