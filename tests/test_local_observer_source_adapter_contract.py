"""FactoryRunner #478: executable offline acceptance of the synthetic source adapter.

No real runner/session, network, live browser, or local listener is accessed.
Node 24's TAP --test-name-pattern selects one test and reports skipped=0.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-source-adapter.test.ts"
COUNTERS = {
    "pass": re.compile(r"(?m)^# pass\s+(\d+)\s*$"),
    "fail": re.compile(r"(?m)^# fail\s+(\d+)\s*$"),
    "skipped": re.compile(r"(?m)^# skipped\s+(\d+)\s*$"),
}


class LocalObserverSourceAdapterContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, passed: int) -> None:
        command = ["node", "--experimental-strip-types", "--test",
                   "--test-reporter=tap"]
        if pattern is not None:
            command += ["--test-name-pattern", pattern]
        command.append(str(SUITE))
        completed = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True,
            timeout=45, check=False,
        )
        output = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, output[-6000:])
        for name, expected in [("pass", passed), ("fail", 0), ("skipped", 0)]:
            match = COUNTERS[name].search(completed.stdout)
            self.assertIsNotNone(match, f"{name} counter missing: {output[-6000:]}")
            self.assertEqual(int(match.group(1)), expected, output[-6000:])

    def test_synthetic_projection_matches_existing_exports(self) -> None:
        self._node("AC01", 1)

    def test_stale_and_future_heartbeat_cannot_claim_freshness(self) -> None:
        self._node("AC02", 1)

    def test_privacy_queue_and_outcome_remain_unknown(self) -> None:
        self._node("AC03", 1)

    def test_pure_adapter_no_io_commands_or_live_authority(self) -> None:
        self._node("AC04", 1)
        self._node(None, 4)


if __name__ == "__main__":
    unittest.main()
