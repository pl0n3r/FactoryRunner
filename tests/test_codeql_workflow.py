"""Executable contract for bounded, real CodeQL execution in GitHub Actions."""
from __future__ import annotations

import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/codeql.yml"


class CodeQLWorkflowTests(unittest.TestCase):
    def test_codeql_init_analyze_share_exact_commit(self):
        """A one-sided Dependabot bump must not silently split action pins."""
        content = WORKFLOW.read_text(encoding="utf-8")
        refs = {}
        for action in ("init", "analyze"):
            prefix = f"uses: github/codeql-action/{action}@"
            matches = [
                line.strip().removeprefix(prefix)
                for line in content.splitlines()
                if line.strip().startswith(prefix)
            ]
            self.assertEqual(len(matches), 1, f"expected one {action} pin")
            self.assertRegex(matches[0], r"^[0-9a-f]{40}$")
            refs[action] = matches[0]
        self.assertEqual(refs["init"], refs["analyze"])

    def test_codeql_workflow_is_bounded_and_minimal(self):
        content = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("name: CodeQL", content)
        self.assertIn("on:\n  pull_request:\n  push:\n    branches: [main]", content)
        self.assertIn("    name: Escanear JS-TS y Python\n", content)
        # Only the official github-advanced-security app may emit check `CodeQL`.
        self.assertNotIn("    name: CodeQL\n", content)
        self.assertIn("    timeout-minutes: 30\n", content)
        self.assertIn("      security-events: write\n", content)
        self.assertIn("      contents: read\n", content)
        self.assertIn("          persist-credentials: false\n", content)
        self.assertIn("          languages: javascript-typescript,python\n", content)
        self.assertIn("          build-mode: none\n", content)
        actions = [
            line.strip().removeprefix("uses: ")
            for line in content.splitlines()
            if line.strip().startswith("uses: ")
        ]
        self.assertEqual(actions, [
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "github/codeql-action/init@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee",
            "github/codeql-action/analyze@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee",
        ])
        for forbidden in (
            "pull_request_target:", "workflow_dispatch:", "workflow_run:",
            "secrets.", "contents: write", "actions: write", "deploy",
            "npm publish", "gh pr merge", "curl ", "wget ",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, content.lower())


if __name__ == "__main__":
    unittest.main()
