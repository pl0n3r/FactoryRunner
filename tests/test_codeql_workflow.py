"""Executable contract for bounded, real CodeQL execution in GitHub Actions."""
from __future__ import annotations

import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/codeql.yml"


class CodeQLWorkflowTests(unittest.TestCase):
    def test_codeql_workflow_is_bounded_and_minimal(self):
        content = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("name: CodeQL", content)
        self.assertIn("on:\n  pull_request:\n  push:\n    branches: [main]", content)
        self.assertIn("    name: CodeQL\n", content)
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
            "github/codeql-action/init@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
            "github/codeql-action/analyze@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
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
