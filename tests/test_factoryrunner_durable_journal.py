"""Aceptación ejecutable del journal durable FactoryRunner #50."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "durable-journal.test.ts"


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


class FactoryRunnerDurableJournalTests(unittest.TestCase):
    def test_append_only_journal_recovers_valid_orders_and_events_after_restart(self):
        output = run_node_test(
            "durable journal recovers valid orders and events after restart"
        )
        self.assertIn("durable journal recovers valid orders and events after restart", output)
        self.assertIn("pass 1", output)

    def test_corrupt_or_conflicting_records_fail_closed_without_replay(self):
        output = run_node_test(
            "durable journal fails closed on corrupt or conflicting records without replay"
        )
        self.assertIn(
            "durable journal fails closed on corrupt or conflicting records without replay",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
