"""FactoryRunner #496: offline executable SHA-256 canonicalization acceptance.

Runs the actual Node/TypeScript TAP suite; no production, network, or secrets.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "stable-sha256.test.ts"
COUNTS = {
    name: re.compile(r"(?m)^# " + re.escape(name) + r"\\s+(\\d+)\\s*$")
    for name in ("tests", "pass", "fail", "skipped", "cancelled")
}


class StableSha256ContractTests(unittest.TestCase):
    def _run_node(self, expected_case: str) -> None:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--test",
             "--test-reporter=tap", str(SUITE)],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=45,
        )
        output = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, output[-6500:])
        self.assertIn(expected_case, completed.stdout, output[-6500:])
        for name, expected in (("tests", 3), ("pass", 3), ("fail", 0),
                               ("skipped", 0), ("cancelled", 0)):
            result = COUNTS[name].search(completed.stdout)
            self.assertIsNotNone(result, f"Missing TAP {name}: {output[-6500:]}")
            self.assertEqual(int(result.group(1)), expected, output[-6500:])

    def test_proto_key_changes_fingerprint(self) -> None:
        self._run_node("AC01 proto key affects root JSON fingerprint")

    def test_nested_proto_and_constructor_keys_remain_material(self) -> None:
        self._run_node("AC02 nested escaped proto and constructor remain material")

    def test_ordinary_json_hashes_are_backward_compatible(self) -> None:
        self._run_node("AC03 ordinary JSON hashes remain backward-compatible")

    def test_node_test_suite_runs(self) -> None:
        self._run_node("AC01 proto key affects root JSON fingerprint")


if __name__ == "__main__":
    unittest.main()
