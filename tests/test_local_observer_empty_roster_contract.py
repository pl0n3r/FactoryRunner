"""Executable AC-01..03 for FactoryRunner #483 direct HTML renderer boundary.

Offline Node 24 tests. No browser, network, credentials or live observers.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-empty-roster.test.ts"
COUNTERS = {
    key: re.compile(r"(?m)^# " + re.escape(key) + r"\s+(\d+)\s*$")
    for key in ("tests", "pass", "fail", "skipped", "cancelled")
}


class EmptyRosterHtmlContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected_pass: int) -> None:
        version = subprocess.run(
            ["node", "--version"], cwd=ROOT, text=True,
            capture_output=True, timeout=10, check=False,
        )
        self.assertEqual(version.returncode, 0, version.stderr)
        self.assertRegex(version.stdout.strip(), r"^v24\.", "Node 24 is required")
        command = ["node", "--experimental-strip-types", "--test",
                   "--test-reporter=tap"]
        if pattern is not None:
            command.extend(["--test-name-pattern", pattern])
        command.append(str(SUITE))
        proc = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True,
            timeout=45, check=False,
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output[-6500:])
        counts: dict[str, int] = {}
        for name, expression in COUNTERS.items():
            match = expression.search(proc.stdout)
            self.assertIsNotNone(match, f"TAP {name} missing: {output[-6500:]}")
            counts[name] = int(match.group(1))
        self.assertEqual(counts["tests"], 3, output[-6500:])
        self.assertEqual(counts["pass"], expected_pass, output[-6500:])
        self.assertEqual(counts["fail"], 0, output[-6500:])
        self.assertEqual(counts["cancelled"], 0, output[-6500:])
        # --test-name-pattern deliberately skips other tests on Node 24.
        self.assertEqual(
            counts["pass"] + counts["skipped"], counts["tests"], output[-6500:]
        )

    def test_renderer_rejects_positive_empty_roster_without_live_claim(self) -> None:
        self._node("AC01 renderer direct FRESH empty roster", 1)

    def test_zero_null_and_fresh_nonempty_states_remain_compatible(self) -> None:
        self._node("AC02 zero null and fresh nonempty", 1)

    def test_renderer_fallback_has_no_active_markup_or_leak(self) -> None:
        self._node("AC03 fallback has no active markup", 1)
        self._node(None, 3)


if __name__ == "__main__":
    unittest.main()
