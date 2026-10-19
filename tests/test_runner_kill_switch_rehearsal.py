"""AC-01 #577: recibo sintético de kill switch/rollback fijado a SHA."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "rehearse-kill-switch-rollback.ts"
DOC = ROOT / "docs" / "runner-kill-switch-rehearsal.md"
BASE_SHA = "87b89bf5648710096e2d90a11f332412975a4771"


class RunnerKillSwitchTests(unittest.TestCase):
    def test_acceptance(self):
        markdown = DOC.read_text(encoding="utf-8")
        fence = re.escape(chr(96) * 3)
        pattern = (r"<!-- rehearsal-evidence-begin -->\s*" + fence
                   + r"json\s*(\{.*?\})\s*" + fence
                   + r"\s*<!-- rehearsal-evidence-end -->")
        match = re.search(pattern, markdown, flags=re.DOTALL)
        self.assertIsNotNone(match, "falta recibo JSON archivado")
        archive = json.loads(match.group(1))
        self.assertEqual(archive["source_sha"], BASE_SHA)
        receipt = archive["receipt"]
        self.assertEqual(receipt["kind"], "offline_fake_only")
        self.assertEqual(receipt["result"], "PASS")
        self.assertTrue(receipt["paused_rejected_at_controlbot"])
        self.assertTrue(receipt["paused_rejected_at_runner"])
        self.assertTrue(receipt["rollback_restored"])
        self.assertRegex(receipt["evidence_sha256"], r"^[a-f0-9]{64}$")
        self.assertNotIn("fake-execution-0001", json.dumps(archive))
        for _ in range(2):
            result = subprocess.run(
                ["node", "--experimental-strip-types", str(SCRIPT), "--source-sha", BASE_SHA],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), archive)
        for invalid in ("main", "deadbeef", "f" * 41):
            rejected = subprocess.run(
                ["node", "--experimental-strip-types", str(SCRIPT), "--source-sha", invalid],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")
            self.assertIn("invalid_offline_rehearsal_request", rejected.stderr)

        # The CLI must not accidentally accept missing or trailing arguments.
        for argv in ((), ("--source-sha",),
                     ("--source-sha", BASE_SHA, "--extra"), ("--sha", BASE_SHA)):
            with self.subTest(argv=argv):
                rejected = subprocess.run(
                    ["node", "--experimental-strip-types", str(SCRIPT), *argv],
                    cwd=ROOT, capture_output=True, text=True, timeout=30,
                    check=False,
                )
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
                self.assertEqual(rejected.stdout, "")
                self.assertIn("invalid_offline_rehearsal_request", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
