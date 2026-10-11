"""#482: executable acceptance for fail-closed positive capacity with empty roster.

Invokes actual Node 24 TAP cases from the bounded snapshot projection suite.
No network, live runner, private host data, or execution is involved.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-snapshot.test.ts"
COUNTS = {
    name: re.compile(r"(?m)^# " + name + r"\s+(\d+)\s*$")
    for name in ("pass", "fail", "skipped")
}


class LocalObserverRosterCapacityContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected_pass: int) -> None:
        cmd = ["node", "--experimental-strip-types", "--test",
               "--test-reporter=tap"]
        if pattern is not None:
            cmd.extend(["--test-name-pattern", pattern])
        cmd.append(str(SUITE))
        proc = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True,
            timeout=45, check=False,
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output[-6500:])
        for name, expected in (
            ("pass", expected_pass), ("fail", 0), ("skipped", 0)
        ):
            match = COUNTS[name].search(proc.stdout)
            self.assertIsNotNone(match, f"TAP {name} missing: {output[-6500:]}")
            self.assertEqual(int(match.group(1)), expected, output[-6500:])

    def test_observed_fresh_empty_roster_rejects_positive_capacity(self) -> None:
        self._node("AC01 observed FRESH empty roster", 1)

    def test_nonempty_and_zero_availability_regression_preserved(self) -> None:
        self._node("AC02 empty nonpositive roster", 1)

    def test_unknown_output_remains_private_and_without_authority(self) -> None:
        self._node("AC03 denial is bounded", 1)


if __name__ == "__main__":
    unittest.main()
