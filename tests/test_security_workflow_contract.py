#!/usr/bin/env python3
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/seguridad.yml"


class SecurityWorkflowContractTests(unittest.TestCase):
    def source(self) -> str:
        return WORKFLOW.read_text(encoding="utf-8")

    def test_owner_exact_decision_commands_use_versioned_factory_security(self) -> None:
        source = self.source()
        self.assertIn("issue_comment:", source)
        self.assertIn("github.event.comment.author_association == 'OWNER'", source)
        self.assertIn("github.event.comment.user.type != 'Bot'", source)
        for option in ("A", "B", "C", "D"):
            self.assertIn(
                f"github.event.comment.body == '/decidir {option}'",
                source,
            )
        self.assertEqual(2, source.count("repository: pl0n3r/factory"))
        self.assertEqual(2, source.count("ref: v1"))
        self.assertIn(".factory/seguridad/sincronizar_puerta.py", source)
        self.assertIn(".factory/seguridad/decision_respuesta.py", source)
        self.assertIn(".factory/seguridad/puertas_humanas.py", source)

    def test_consumer_code_is_never_checked_out_or_executed(self) -> None:
        source = self.source()
        self.assertEqual(2, source.count("uses: actions/checkout@"))
        self.assertEqual(2, source.count("repository: pl0n3r/factory"))
        self.assertEqual(2, source.count("path: .factory"))
        self.assertEqual(2, source.count("persist-credentials: false"))
        self.assertNotIn("repository: pl0n3r/FactoryRunner", source)
        self.assertNotIn("repository: $" + "{{ github.repository }}", source)
        self.assertNotIn("working-directory:", source)

    def test_issue_routing_uses_minimal_permissions_and_fail_closed_triggers(self) -> None:
        source = self.source()
        self.assertIn("types: [opened, edited, reopened]", source)
        self.assertIn("types: [created]", source)
        self.assertIn("permissions:\n  contents: read", source)
        self.assertEqual(2, source.count("issues: write"))
        self.assertIn("cancel-in-progress: false", source)
        self.assertIn("github.event.issue.pull_request == null", source)
        self.assertIn("github.event.issue.state == 'open'", source)
        self.assertIn("steps.gate_sync.outputs.canonical == 'true'", source)
        self.assertIn("status == 'invalid-gate'", source)

    def test_historical_or_untrusted_comments_are_not_replayed(self) -> None:
        source = self.source()
        for forbidden in (
            "workflow_run:",
            "schedule:",
            "repository_dispatch:",
            "comments?per_page=",
            "issues/comments?per_page=",
        ):
            self.assertNotIn(forbidden, source)
        self.assertIn("github.event_name == 'issue_comment'", source)
        self.assertEqual(
            1,
            source.count("github.event.comment.author_association == 'OWNER'"),
        )
        self.assertIn("OWNER|MEMBER|COLLABORATOR", source)
        self.assertNotIn("author_association == 'MEMBER'", source)
        self.assertNotIn("author_association == 'COLLABORATOR'", source)


if __name__ == "__main__":
    unittest.main()
