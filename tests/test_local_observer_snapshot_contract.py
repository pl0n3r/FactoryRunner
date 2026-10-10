"""Acceptance FactoryRunner #466: Python wrappers execute actual Node TS tests."""
from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = "tests/local-observer-snapshot.test.ts"


class LocalObserverSnapshotContractTests(unittest.TestCase):
    def _node(self, scenario: str) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node runtime required; no fake success")
        result = subprocess.run(
            [node, "--experimental-strip-types", "--test", "--test-reporter=tap",
             f"--test-name-pattern={scenario}", SPEC],
            cwd=ROOT, capture_output=True, text=True, timeout=60, check=False,
        )
        output = result.stdout + "\n" + result.stderr
        self.assertEqual(result.returncode, 0, output[-10000:])
        self.assertRegex(output, r"(?m)^# pass\s+1\b", output[-10000:])
        self.assertRegex(output, r"(?m)^# fail\s+0\b", output[-10000:])

    def test_snapshot_accepts_only_canonical_safe_fields(self):
        self._node("canonical safe fields")

    def test_stale_unknown_and_synthetic_provenance_fail_closed(self):
        self._node("stale cached synthetic")

    def test_no_tokens_chat_content_or_pii_in_projection(self):
        self._node("secrets PII HTML")


if __name__ == "__main__":
    unittest.main()
