"""Offline executable acceptance for FactoryRunner #492 (non-READY roster).

Tests the real Node snapshot projector suite with synthetic fixtures only.
Does not inspect the host, start listeners, read chats or use credentials.
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
    for name in ("tests", "pass", "fail", "skipped", "cancelled")
}


class NonreadyCapacityContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected_pass: int) -> None:
        command = [
            "node", "--experimental-strip-types", "--test", "--test-reporter=tap"
        ]
        if pattern:
            command.extend(["--test-name-pattern", pattern])
        command.append(str(SUITE))
        proc = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True,
            check=False, timeout=45,
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output[-6000:])
        for name, expected in (
            ("tests", expected_pass), ("pass", expected_pass),
            ("fail", 0), ("skipped", 0), ("cancelled", 0),
        ):
            match = COUNTS[name].search(proc.stdout)
            self.assertIsNotNone(match, f"TAP {name} absent: {output[-6000:]}")
            self.assertEqual(int(match.group(1)), expected, output[-6000:])

    def test_nonready_roster_with_positive_capacity_fails_closed(self) -> None:
        self._node("AC01 nonready roster positive capacity", 1)

    def test_ready_heartbeat_and_nonpositive_capacity_remain_compatible(self) -> None:
        self._node("AC02 READY heartbeat and nonpositive capacity", 1)

    def test_denial_does_not_leak_payload_or_grant_authority(self) -> None:
        self._node("AC03 nonready denial remains private", 1)
        self._node(None, 9)


if __name__ == "__main__":
    unittest.main()
