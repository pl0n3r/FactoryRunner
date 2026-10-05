import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src/execution-recovery-handoff-public-compatibility.ts").read_text(
    encoding="utf-8"
)
ALLOWED_REASONS = {
    "CONTRACT_MISSING",
    "MANIFEST_INVALID",
    "REQUIREMENTS_INVALID",
    "VERSION_MISMATCH",
}


def observe() -> dict[str, object]:
    script = r"""
import { executionRecoveryHandoffPublicManifest } from './src/execution-recovery-handoff-public-manifest.ts';
import { executionRecoveryHandoffPublicCompatibility } from './src/execution-recovery-handoff-public-compatibility.ts';

const manifest = executionRecoveryHandoffPublicManifest();
const requirements = manifest.exports.map((entry) => ({
  export_name: entry.export_name,
  contract_version: entry.contract_version,
}));
const exact = executionRecoveryHandoffPublicCompatibility(manifest, requirements);
const exactAgain = executionRecoveryHandoffPublicCompatibility(manifest, requirements);

const unknownRequirement = executionRecoveryHandoffPublicCompatibility(
  manifest,
  [...requirements, { export_name: 'executionRecoveryHandoffUnknown', contract_version: 1 }],
);
const versionMismatch = executionRecoveryHandoffPublicCompatibility(
  manifest,
  requirements.map((entry, index) => index === 0 ? { ...entry, contract_version: 2 } : entry),
);
const malformedRequirement = executionRecoveryHandoffPublicCompatibility(
  manifest,
  requirements.map((entry, index) => index === 0 ? { ...entry, unexpected: true } : entry),
);
const duplicateRequirement = executionRecoveryHandoffPublicCompatibility(
  manifest,
  [requirements[0], requirements[0]],
);

const tamperedManifest = executionRecoveryHandoffPublicCompatibility(
  { ...manifest, fingerprint: '0'.repeat(64) },
  requirements,
);
const mixedManifest = executionRecoveryHandoffPublicCompatibility(
  {
    ...manifest,
    exports: [
      ...manifest.exports,
      { export_name: 'executionRecoveryHandoffUnknown', contract_version: 1 },
    ],
  },
  requirements,
);
const unknownManifest = executionRecoveryHandoffPublicCompatibility(
  { ...manifest, version: 2 },
  requirements,
);

console.log(JSON.stringify({
  manifest,
  exact,
  exactAgain,
  exactFrozen: Object.isFrozen(exact),
  reasonsFrozen: Object.isFrozen(exact.reasons),
  invalid: {
    unknownRequirement,
    versionMismatch,
    malformedRequirement,
    duplicateRequirement,
    tamperedManifest,
    mixedManifest,
    unknownManifest,
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


class FactoryRunnerExecutionRecoveryHandoffPublicCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_exact_supported_requirements_are_compatible_deterministically(self):
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

    def test_unknown_mixed_tampered_or_version_mismatch_fails_closed_without_effects(self):
        expected = {
            "unknownRequirement": ["CONTRACT_MISSING"],
            "versionMismatch": ["VERSION_MISMATCH"],
            "malformedRequirement": ["REQUIREMENTS_INVALID"],
            "duplicateRequirement": ["REQUIREMENTS_INVALID"],
            "tamperedManifest": ["MANIFEST_INVALID"],
            "mixedManifest": ["MANIFEST_INVALID"],
            "unknownManifest": ["MANIFEST_INVALID"],
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
                self.assertRegex(result["fingerprint"], r"^[0-9a-f]{64}$")

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
                self.assertNotIn(forbidden, SOURCE)


if __name__ == "__main__":
    unittest.main()
