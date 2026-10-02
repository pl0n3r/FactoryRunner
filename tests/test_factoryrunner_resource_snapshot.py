"""Aceptación ejecutable de ResourceSnapshot FactoryRunner #65."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "resource-snapshot.test.ts"


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


class FactoryRunnerResourceSnapshotTests(unittest.TestCase):
    def test_resource_snapshot_is_derived_from_observed_runtime_state_with_freshness(self):
        output = run_node_test(
            "ResourceSnapshot is derived from observed runtime state with freshness"
        )
        self.assertIn(
            "ResourceSnapshot is derived from observed runtime state with freshness",
            output,
        )
        self.assertIn("pass 1", output)

    def test_stale_future_or_incoherent_resource_observation_fails_closed(self):
        output = run_node_test(
            "ResourceSnapshot fails closed on stale future or incoherent observation"
        )
        self.assertIn(
            "ResourceSnapshot fails closed on stale future or incoherent observation",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
