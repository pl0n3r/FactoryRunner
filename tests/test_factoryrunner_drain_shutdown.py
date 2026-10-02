"""Aceptación ejecutable de drain/shutdown FactoryRunner #59."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "runtime-supervisor.test.ts"


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


class FactoryRunnerDrainShutdownTests(unittest.TestCase):
    def test_draining_refuses_new_orders_and_preserves_inflight_terminalization(self):
        output = run_node_test(
            "runtime supervisor draining refuses new orders and preserves inflight terminalization"
        )
        self.assertIn(
            "runtime supervisor draining refuses new orders and preserves inflight terminalization",
            output,
        )
        self.assertIn("pass 1", output)

    def test_heartbeat_capacity_is_derived_from_observed_runtime_state(self):
        output = run_node_test(
            "runtime supervisor heartbeat capacity is derived from observed runtime state"
        )
        self.assertIn(
            "runtime supervisor heartbeat capacity is derived from observed runtime state",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
