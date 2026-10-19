"""AC-01 #576: FactoryRunner E2E de registro, orden, ack y replay sobre HTTP local."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "tests" / "e2e-controlbot-mock.test.ts"
NAME = "runner e2e mock completes registration order ack and replay once"


class RunnerE2eMockTests(unittest.TestCase):
    def test_acceptance(self):
        result = subprocess.run(
            [
                "node", "--experimental-strip-types", "--test",
                f"--test-name-pattern={NAME}", str(CASE),
            ],
            cwd=ROOT, capture_output=True, text=True,
            timeout=40, check=False,
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertIn(NAME, output)
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
