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

    def test_duplicate_top_level_operation_keys_fail_closed(self):
        output = run_node_test(
            "AC01 durable outbox denies conflicting top-level op declarations"
        )
        self.assertIn("AC01 durable outbox denies conflicting top-level op declarations", output)
        self.assertIn("pass 1", output)

    def test_duplicate_nested_delivery_keys_fail_closed(self):
        output = run_node_test(
            "AC02 durable outbox denies nested duplicate fingerprints and requests"
        )
        self.assertIn("AC02 durable outbox denies nested duplicate fingerprints and requests", output)
        self.assertIn("pass 1", output)

    def test_noncanonical_lines_fail_closed_but_appended_legacy_lines_recover(self):
        output = run_node_test(
            "AC03 durable outbox rejects noncanonical NDJSON but replays genuine append-only records"
        )
        self.assertIn(
            "AC03 durable outbox rejects noncanonical NDJSON but replays genuine append-only records",
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


    def test_symlink_outbox_does_not_read_or_write_target(self):
        output = run_node_test("AC01 symlink outbox does not read or write target")
        self.assertIn("AC01 symlink outbox does not read or write target", output)
        self.assertIn("pass 1", output)

    def test_dangling_symlink_and_nonregular_file_fail_closed(self):
        output = run_node_test("AC02 dangling symlink and nonregular file fail closed")
        self.assertIn("AC02 dangling symlink and nonregular file fail closed", output)
        self.assertIn("pass 1", output)

    def test_regular_outbox_append_and_restart_remain_compatible(self):
        output = run_node_test("AC03 regular outbox append and restart remain compatible")
        self.assertIn("AC03 regular outbox append and restart remain compatible", output)
        self.assertIn("pass 1", output)


    def test_oversized_sparse_outbox_fails_before_unbounded_read(self):
        output = run_node_test("AC01 bounded reader rejects oversized sparse outbox before unbounded read")
        self.assertIn("pass 1", output)

    def test_bounded_reader_preserves_regular_recovery_idempotency(self):
        output = run_node_test("AC02 bounded reader preserves regular recovery and idempotency")
        self.assertIn("pass 1", output)

    def test_bounded_reader_preserves_nonregular_fail_closed(self):
        output = run_node_test("AC03 bounded reader preserves ENOENT and nonregular fail closed")
        self.assertIn("pass 1", output)

    def test_invalid_utf8_fails_closed_without_rewrite(self):
        """AC-02/03: reject malformed bytes and preserve authentic Unicode."""
        for pattern in (
            "AC02 outbox rejects malformed UTF-8 before replay or enqueue",
            "AC03 outbox authentic Unicode including U+FFFD round-trips unchanged",
        ):
            output = run_node_test(pattern)
            self.assertIn("pass 1", output)

    def test_outbox_append_rejects_crossing_size_limit_without_changes(self):
        output = run_node_test("AC01 outbox append rejects crossing aggregate size cap without changes")
        self.assertIn("pass 1", output)

    def test_outbox_append_fits_remaining_size_and_recovers(self):
        output = run_node_test("AC02 outbox append within remaining aggregate size recovers on restart")
        self.assertIn("pass 1", output)

    def test_oversized_existing_outbox_is_never_appended(self):
        output = run_node_test("AC03 existing oversized outbox refuses new append and preserves bytes")
        self.assertIn("pass 1", output)



    def test_post_fstat_growth_is_bounded_and_fails_closed(self):
        """AC-01: count actual reads on deterministic growth after fstat."""
        output = run_node_test(
            "AC01 outbox post-fstat growth rejects within bounded bytes"
        )
        self.assertIn("pass 1", output)

    def test_post_fstat_regression_preserves_regular_recovery(self):
        """AC-02: keep real recovery, idempotency and aggregate-size boundary."""
        for pattern in (
            "AC02 bounded reader preserves regular recovery and idempotency",
            "AC02 outbox append within remaining aggregate size recovers on restart",
        ):
            self.assertIn("pass 1", run_node_test(pattern))


if __name__ == "__main__":
    unittest.main()
