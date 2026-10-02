"""Shared Node test runner for executable Python acceptance wrappers."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "runtime-supervisor.test.ts"


class NodeAcceptanceCase(unittest.TestCase):
    def assert_node_test(self, name: str) -> None:
        result = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--test",
                f"--test-name-pattern={name}",
                str(NODE_TEST),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )
        output = result.stdout + result.stderr
        if result.returncode != 0:
            self.fail(output)
        self.assertIn(name, output)
        self.assertIn("pass 1", output)
