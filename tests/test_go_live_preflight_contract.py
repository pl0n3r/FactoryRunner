"""AC tests for the reversible, offline-only #585 preflight."""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "go-live-preflight.ts"
DOC = ROOT / "docs" / "go-live-preflight.md"
TEST = ROOT / "tests" / "go-live-preflight.test.ts"


class GoLivePreflightContractTests(unittest.TestCase):
    def test_acceptance(self):
        script = DOC.read_text(encoding="utf-8")
        for expected in (
            "ControlBot real", "rollback", "restore", "Hostinger",
            "privacy", "live_authorized=false", "readiness=UNKNOWN",
            "human approval", "offline_preflight", "synthetic_only",
        ):
            self.assertIn(expected, script)
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test", str(TEST)],
            cwd=ROOT, capture_output=True, text=True, timeout=40, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)
        self.assertIn("pass 4", result.stdout)
        self.assertIn("fail 0", result.stdout)

    def test_ci_contract(self):
        code = SRC.read_text(encoding="utf-8")
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("node-typecheck:", ci)
        self.assertIn("npm run typecheck", ci)
        self.assertIn("npm test", ci)
        self.assertIn("name: validate", ci)
        self.assertIn("createHash", code)
        for prohibited in ("node:fs", "node:http", "node:https", "node:child_process", "fetch(", "process.env", "listen("):
            self.assertNotIn(prohibited, code)

    def test_never_authorizes_live(self):
        code = SRC.read_text(encoding="utf-8")
        self.assertIn("live_authorized: false as const", code)
        self.assertIn("readiness: 'UNKNOWN' as const", code)
        self.assertNotRegex(code, r"live_authorized\s*:\s*true")
        self.assertNotRegex(code, r"readiness\s*:\s*['\"]READY")
        self.assertRegex(code, r"mode: 'offline_preflight' as const")


if __name__ == "__main__":
    unittest.main()
