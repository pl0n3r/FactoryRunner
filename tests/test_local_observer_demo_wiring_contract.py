"""Executable offline acceptance of the typed synthetic demo (#480).

Only Node's own loopback tests may bind 127.0.0.1; no real runner,
external network, secrets, production service or executing session is touched.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-server.test.ts"
COUNTERS = {
    "pass": re.compile(r"(?m)^# pass\s+(\d+)\s*$"),
    "fail": re.compile(r"(?m)^# fail\s+(\d+)\s*$"),
    "skipped": re.compile(r"(?m)^# skipped\s+(\d+)\s*$"),
}


class LocalObserverDemoWiringContractTests(unittest.TestCase):
    def _node(self, pattern: str | None, expected_pass: int) -> None:
        command = ["node", "--experimental-strip-types", "--test",
                   "--test-reporter=tap"]
        if pattern is not None:
            command.extend(["--test-name-pattern", pattern])
        command.append(str(SUITE))
        proc = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, timeout=45,
            check=False,
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output[-6000:])
        # In Node 24 selected tests are enumerated, not reported as skipped.
        for name, expected in (("pass", expected_pass), ("fail", 0),
                               ("skipped", 0)):
            match = COUNTERS[name].search(proc.stdout)
            self.assertIsNotNone(match, f"Missing TAP {name}: {output[-6000:]}")
            self.assertEqual(int(match.group(1)), expected, output[-6000:])

    def test_demo_uses_synthetic_adapter_fixture(self) -> None:
        self._node("AC05", 1)

    def test_health_remains_unknown_and_read_only(self) -> None:
        self._node("AC06", 1)

    def test_bad_inputs_never_enable_live_or_remote(self) -> None:
        self._node("AC07", 1)
        self._node(None, 7)


if __name__ == "__main__":
    unittest.main()
