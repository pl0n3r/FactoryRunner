"""Aceptación ejecutable del result envelope FactoryRunner #52."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "result-envelope.test.ts"


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


class FactoryRunnerResultEnvelopeTests(unittest.TestCase):
    def test_result_envelope_binds_order_runner_sequence_and_sanitized_evidence(self):
        output = run_node_test(
            "result envelope binds order runner sequence and sanitized evidence"
        )
        self.assertIn(
            "result envelope binds order runner sequence and sanitized evidence",
            output,
        )
        self.assertIn("pass 1", output)

    def test_capacity_snapshot_is_derived_from_observed_runner_and_queue_state(self):
        output = run_node_test(
            "capacity snapshot is derived from observed runner and queue state"
        )
        self.assertIn(
            "capacity snapshot is derived from observed runner and queue state",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
