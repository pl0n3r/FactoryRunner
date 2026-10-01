"""Aceptación ejecutable del execution loop FactoryRunner #51."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "execution-loop.test.ts"


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


class FactoryRunnerExecutionLoopTests(unittest.TestCase):
    def test_worker_dispatches_validated_orders_once_through_registered_adapter(self):
        output = run_node_test(
            "execution loop dispatches validated orders once through registered adapter"
        )
        self.assertIn(
            "execution loop dispatches validated orders once through registered adapter",
            output,
        )
        self.assertIn("pass 1", output)

    def test_timeout_cancel_and_restart_preserve_terminal_state_without_duplicate_effect(self):
        output = run_node_test(
            "timeout cancel and restart preserve terminal state without duplicate effect"
        )
        self.assertIn(
            "timeout cancel and restart preserve terminal state without duplicate effect",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
