"""Wrapper de aceptación Factory v1 para el ensayo TypeScript offline #472."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = "tests/kill-switch-rollback-rehearsal.test.ts"


class KillSwitchRollbackRehearsalTests(unittest.TestCase):
    def _run(self, name: str) -> None:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--test",
             "--test-reporter=tap", f"--test-name-pattern={name}", SPEC],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
            check=False,
        )
        self.assertEqual(
            completed.returncode, 0,
            f"{name}: {completed.stdout[-2500:]} {completed.stderr[-1000:]}",
        )
        self.assertIn("# pass 1", completed.stdout)
        self.assertIn("# fail 0", completed.stdout)

    def test_kill_switch_blocks_new_executions(self) -> None:
        self._run("AC-01")

    def test_rollback_restores_snapshot(self) -> None:
        self._run("AC-02")

    def test_evidence_redacted_and_offline(self) -> None:
        self._run("AC-03")


if __name__ == "__main__":
    unittest.main()
