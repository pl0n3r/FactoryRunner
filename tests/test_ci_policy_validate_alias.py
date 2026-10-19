"""FactoryRunner #583: an authenticated validate check cannot mask failed CI."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"


class ValidateAliasTests(unittest.TestCase):
    def test_acceptance(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(source.count("\n  validate:\n"), 1)
        body = source.split("\n  validate:\n", 1)[1].split("\n  tests:\n", 1)[0]
        self.assertRegex(body, r"(?m)^    name: validate$")
        self.assertRegex(body, r"(?m)^    needs: \[ci, node-typecheck\]$")
        self.assertIn("    if: ${{ always() && github.event_name == 'pull_request' }}", body)
        self.assertIn("    permissions:\n      contents: read", body)
        self.assertIn("          CI_RESULT: ${{ needs.ci.result }}", body)
        self.assertIn("          TYPECHECK_RESULT: ${{ needs['node-typecheck'].result }}", body)
        self.assertNotIn("pull_request_target:", source)
        self.assertNotIn("workflow_dispatch:", source)
        self.assertNotIn("id-token: write", body)
        self.assertIn("        run: |\n", body)
        run_lines = body.split("        run: |\n", 1)[1].splitlines()
        command = "\n".join(line[10:] for line in run_lines if line.startswith("          ")) + "\n"
        self.assertIn("set -euo pipefail", command)
        self.assertIn('"$CI_RESULT" == "success"', command)
        self.assertIn('"$TYPECHECK_RESULT" == "success"', command)
        self.assertEqual(command.count("exit 1"), 2)

        # El sexto gate de Factory Policy necesita un check tests distinto.
        # Ese check ejecuta aceptación real y falla cerrado sobre ambos jobs.
        self.assertEqual(source.count("\n  tests:\n"), 1)
        tests_body = source.split("\n  tests:\n", 1)[1]
        self.assertRegex(tests_body, r"(?m)^    name: tests$")
        self.assertIn("    needs: [ci, node-typecheck]", tests_body)
        self.assertIn("    if: ${{ always() && github.event_name == 'pull_request' }}", tests_body)
        self.assertIn("    permissions:\n      contents: read", tests_body)
        self.assertIn("          CI_RESULT: ${{ needs.ci.result }}", tests_body)
        self.assertIn("          TYPECHECK_RESULT: ${{ needs['node-typecheck'].result }}", tests_body)
        self.assertIn("run: python3 -m unittest discover -s tests -p 'test_ci_policy_validate_alias.py'", tests_body)
        tests_guard = tests_body.split("        run: |\n", 1)[1].split("      - uses:", 1)[0]
        tests_command = "\n".join(line[10:] for line in tests_guard.splitlines() if line.startswith("          ")) + "\n"
        self.assertEqual(tests_command.count("exit 1"), 2)
        for ci, typecheck, expected in (("success", "success", 0), ("failure", "success", 1), ("success", "skipped", 1)):
            with self.subTest(tests_gate_ci=ci, tests_gate_typecheck=typecheck):
                env = {**os.environ, "CI_RESULT": ci, "TYPECHECK_RESULT": typecheck}
                actual = subprocess.run(["bash", "-c", tests_command], cwd=ROOT, env=env, capture_output=True, text=True, timeout=5, check=False)
                self.assertEqual(actual.returncode, expected, actual.stderr)

        for ci, typecheck, expected in (
            ("success", "success", 0),
            ("failure", "success", 1),
            ("success", "failure", 1),
            ("skipped", "success", 1),
            ("success", "skipped", 1),
            ("cancelled", "success", 1),
            ("success", "cancelled", 1),
            ("pending", "success", 1),
        ):
            with self.subTest(ci=ci, typecheck=typecheck):
                env = {**os.environ, "CI_RESULT": ci, "TYPECHECK_RESULT": typecheck}
                result = subprocess.run(
                    ["bash", "-c", command],
                    cwd=ROOT, env=env,
                    capture_output=True, text=True, timeout=5, check=False,
                )
                self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
