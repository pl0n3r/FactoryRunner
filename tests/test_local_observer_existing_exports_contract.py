"""#476: executable acceptance of existing runner exports through the synthetic observer.

No live runner, ControlBot, network access, credentials, or HTTP listener.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-existing-exports.test.ts"
COUNTERS = {
    "pass": re.compile(r"(?m)^# pass\s+(\d+)\s*$"),
    "fail": re.compile(r"(?m)^# fail\s+(\d+)\s*$"),
    "skipped": re.compile(r"(?m)^# skipped\s+(\d+)\s*$"),
}


class LocalObserverExistingExportsContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected_pass: int, expected_skip: int) -> None:
        command = ["node", "--experimental-strip-types", "--test",
                   "--test-reporter=tap"]
        if pattern is not None:
            command.extend(["--test-name-pattern", pattern])
        command.append(str(SUITE))
        completed = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True,
            timeout=45, check=False,
        )
        output = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, output[-6000:])
        for name, expected in [
            ("pass", expected_pass), ("fail", 0), ("skipped", expected_skip),
        ]:
            match = COUNTERS[name].search(completed.stdout)
            self.assertIsNotNone(match, f"{name} counter missing: {output[-6000:]}")
            self.assertEqual(int(match.group(1)), expected, output[-6000:])

    def test_export_fixture_through_synthetic_observer(self) -> None:
        self._node("AC01", 1, 3)

    def test_stale_offline_and_mismatch_fail_closed(self) -> None:
        self._node("AC02", 1, 3)

    def test_private_evidence_never_rendered(self) -> None:
        self._node("AC03", 1, 3)

    def test_all_node_acceptance_cases_are_discoverable(self) -> None:
        self._node(None, 4, 0)


if __name__ == "__main__":
    unittest.main()
