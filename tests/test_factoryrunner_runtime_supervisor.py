"""Aceptación ejecutable del runtime supervisor FactoryRunner #58."""
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


class FactoryRunnerRuntimeSupervisorTests(unittest.TestCase):
    def test_tick_durably_accepts_before_ack_execute_and_publish(self):
        output = run_node_test(
            "runtime supervisor durably accepts before ack execute and publish"
        )
        self.assertIn(
            "runtime supervisor durably accepts before ack execute and publish",
            output,
        )
        self.assertIn("pass 1", output)

    def test_restart_reuses_terminal_state_without_duplicate_dispatch(self):
        output = run_node_test(
            "runtime supervisor restart reuses terminal state without duplicate dispatch"
        )
        self.assertIn(
            "runtime supervisor restart reuses terminal state without duplicate dispatch",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
