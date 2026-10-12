"""Offline acceptance for FactoryRunner #531: ENOENT only means missing on open."""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_SUITE = ROOT / "tests" / "outbox-read-enoent.test.ts"


def run_node_test(name: str) -> None:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--test",
            f"--test-name-pattern={name}",
            str(NODE_SUITE),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=25,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    if "pass 1" not in result.stdout:
        raise AssertionError("Expected exactly one passing Node test: " + result.stdout)


class OutboxReadEnoentTests(unittest.TestCase):
    def test_read_enoent_after_open_fails_closed(self):
        run_node_test("AC01 read ENOENT after successful open fails closed")

    def test_missing_outbox_still_empty(self):
        run_node_test("AC02 missing outbox is still an empty queue")

    def test_recovery_unchanged_after_injected_error(self):
        run_node_test("AC03 recovery after read error preserves pending delivery and idempotency")


if __name__ == "__main__":
    unittest.main()
