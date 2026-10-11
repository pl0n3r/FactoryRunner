"""Offline acceptance for FactoryRunner #488's in-process candidate projection.

No source collection, browser automation, Mac filesystem, network or secrets.
Runs the real Node TAP suite; CI's Node job selects the supported runtime.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-runtime-projection.test.ts"
TAP = {
    key: re.compile(r"(?m)^# " + re.escape(key) + r"\s+(\d+)\s*$")
    for key in ("tests", "pass", "fail", "skipped", "cancelled")
}


class RuntimeObserverProjectionContractTests(unittest.TestCase):
    def _run(self, pattern: str | None, expected_pass: int) -> None:
        command = ["node", "--experimental-strip-types", "--test",
                   "--test-reporter=tap"]
        if pattern:
            command.extend(["--test-name-pattern", pattern])
        command.append(str(SUITE))
        completed = subprocess.run(
            command, cwd=ROOT, text=True, capture_output=True,
            timeout=45, check=False,
        )
        output = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, output[-6500:])
        counts: dict[str, int] = {}
        for key, expression in TAP.items():
            found = expression.search(completed.stdout)
            self.assertIsNotNone(found, f"Missing TAP {key}: {output[-6500:]}")
            counts[key] = int(found.group(1))
        # The filtered runner enumerates one selected case on supported
        # Node versions. No skipped or cancelled cases may hide failures.
        expected_cases = expected_pass if pattern else 3
        for key, wanted in (("tests", expected_cases), ("pass", expected_pass),
                            ("fail", 0), ("skipped", 0), ("cancelled", 0)):
            self.assertEqual(counts[key], wanted, output[-6500:])

    def test_consistent_fresh_candidate_reports_only_bounded_status(self) -> None:
        self._run("AC01 consistent fresh candidate", 1)

    def test_absolute_age_future_and_sequence_fail_closed(self) -> None:
        self._run("AC02 absolute age future sequence", 1)

    def test_sensitive_fields_and_runtime_actions_never_leak(self) -> None:
        self._run("AC03 no sensitive fields", 1)
        self._run(None, 3)


if __name__ == "__main__":
    unittest.main()
