"""Aceptación ejecutable del outbox durable FactoryRunner #57."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "durable-outbox.test.ts"


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


class FactoryRunnerDurableOutboxTests(unittest.TestCase):
    def test_pending_ack_and_events_survive_restart_with_stable_idempotency(self):
        output = run_node_test(
            "durable outbox keeps pending ack and events across restart with stable idempotency"
        )
        self.assertIn(
            "durable outbox keeps pending ack and events across restart with stable idempotency",
            output,
        )
        self.assertIn("pass 1", output)

    def test_corrupt_or_conflicting_delivery_state_fails_closed(self):
        output = run_node_test(
            "durable outbox fails closed on corrupt or conflicting delivery state"
        )
        self.assertIn(
            "durable outbox fails closed on corrupt or conflicting delivery state",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
