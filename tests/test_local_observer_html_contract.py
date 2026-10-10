"""FactoryRunner #467: each acceptance test executes the real Node suite."""
from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = "tests/local-observer-html.test.ts"


class LocalObserverHtmlContractTests(unittest.TestCase):
    def _node(self, scenario: str) -> str:
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node runtime required for actual contract execution")
        run = subprocess.run(
            [node, "--experimental-strip-types", "--test", f"--test-name-pattern={scenario}", SPEC],
            cwd=ROOT, capture_output=True, text=True, timeout=60, check=False,
        )
        output = run.stdout + "\n" + run.stderr
        self.assertEqual(run.returncode, 0, output[-10000:])
        self.assertRegex(output, r"(?m)^# pass\s+1\b", output[-10000:])
        self.assertRegex(output, r"(?m)^# fail\s+0\b", output[-10000:])
        return output

    def test_render_escapes_untrusted_content_and_no_remote_resources(self):
        self._node("render escapes untrusted content")

    def test_390_and_1440_layout_accessibility_without_scripts(self):
        self._node("390 and 1440 viewports")

    def test_unknown_stale_and_empty_render_fail_closed(self):
        self._node("unknown stale and empty states")


if __name__ == "__main__":
    unittest.main()
