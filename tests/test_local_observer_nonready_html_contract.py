"""FactoryRunner #493: executable, synthetic-only renderer acceptance.

Invokes actual Node TAP, never the Mac, agents, sessions or HTTP listeners.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-nonready-html.test.ts"
COUNTS = {
    name: re.compile(r"(?m)^# " + re.escape(name) + r"\s+(\d+)\s*$")
    for name in ("tests", "pass", "fail", "skipped", "cancelled")
}


class NonreadyHtmlContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected: int) -> None:
        args = ["node", "--experimental-strip-types", "--test", "--test-reporter=tap"]
        if pattern is not None:
            args.extend(["--test-name-pattern", pattern])
        args.append(str(SUITE))
        result = subprocess.run(
            args, cwd=ROOT, text=True, capture_output=True, check=False,
            timeout=45,
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output[-6500:])
        for name, wanted in (
            ("tests", expected), ("pass", expected),
            ("fail", 0), ("skipped", 0), ("cancelled", 0),
        ):
            found = COUNTS[name].search(result.stdout)
            self.assertIsNotNone(found, f"missing TAP {name}: {output[-6500:]}")
            self.assertEqual(int(found.group(1)), wanted, output[-6500:])

    def test_renderer_rejects_positive_nonready_roster(self) -> None:
        self._node("AC01 renderer denies positive capacity", 1)

    def test_renderer_preserves_ready_and_nonpositive_regressions(self) -> None:
        self._node("AC02 fresh READY and nonpositive", 1)

    def test_renderer_fallback_never_leaks_payload_or_actions(self) -> None:
        self._node("AC03 invalid direct input never leaks", 1)
        self._node(None, 3)


if __name__ == "__main__":
    unittest.main()
