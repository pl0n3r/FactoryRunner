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


    def test_duplicate_top_level_record_keys_fail_closed(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC01 durable journal denies duplicate top-level kind and version keys"),
        )

    def test_duplicate_nested_payload_keys_fail_closed(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC02 durable journal denies duplicate nested payload keys without replay"),
        )

    def test_noncanonical_lines_fail_closed_but_valid_append_only_recovers(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC03 durable journal rejects noncanonical NDJSON but recovers writer records"),
        )



    def test_symlink_journal_denies_recovery_and_append_without_touching_target(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC01 journal symlink denies recovery and append without touching target"),
        )

    def test_dangling_symlink_and_nonregular_journal_fail_closed(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC02 journal dangling symlink and nonregular file fail closed"),
        )

    def test_regular_journal_creation_restart_and_idempotency_preserved(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC03 journal regular file creation restart and idempotency preserved"),
        )


    def test_journal_append_rejects_crossing_size_limit_without_changes(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC01 journal append rejects crossing size limit without changes"),
        )

    def test_journal_append_fits_remaining_size_and_recovers(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC02 journal append fits remaining size and recovers"),
        )

    def test_oversized_existing_journal_is_never_appended(self):
        self.assertIn(
            "pass 1",
            run_node_test("AC03 oversized existing journal is never appended"),
        )

    def test_invalid_utf8_fails_closed_without_rewrite(self):
        """AC-01/03: reject malformed bytes while retaining genuine Unicode."""
        for pattern in (
            "AC01 journal rejects malformed UTF-8 before replay or append",
            "AC03 journal authentic Unicode including U+FFFD round-trips unchanged",
        ):
            output = run_node_test(pattern)
            self.assertIn("pass 1", output)

if __name__ == "__main__":
    unittest.main()
