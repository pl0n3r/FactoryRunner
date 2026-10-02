"""Aceptación ejecutable de CapabilityManifest FactoryRunner #64."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "capability-manifest.test.ts"


def run_node_test(name: str) -> str:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--test",
            f"--test-name-pattern={name}",
            str(NODE_TEST),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise AssertionError(output)
    return output


class FactoryRunnerCapabilityManifestTests(unittest.TestCase):
    def test_manifest_is_derived_from_identity_and_registered_adapters(self):
        output = run_node_test(
            "CapabilityManifest is derived from identity and registered adapters"
        )
        self.assertIn(
            "CapabilityManifest is derived from identity and registered adapters",
            output,
        )
        self.assertIn("pass 1", output)

    def test_capability_drift_or_duplicate_adapter_mapping_fails_closed(self):
        output = run_node_test(
            "CapabilityManifest fails closed on capability drift or duplicate adapter mapping"
        )
        self.assertIn(
            "CapabilityManifest fails closed on capability drift or duplicate adapter mapping",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
