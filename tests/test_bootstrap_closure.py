"""Regresiones del cierre de bootstrap FactoryRunner."""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class BootstrapClosureTests(unittest.TestCase):
    def test_d062_is_active_and_preserves_runner_separation(self) -> None:
        data = json.loads((ROOT / "decisiones.yml").read_text(encoding="utf-8"))
        decisions = {row["id"]: row for row in data["decisions"]}
        self.assertEqual("active", decisions["D-062"]["status"])
        self.assertIn("son públicos", decisions["D-062"]["text"])
        self.assertIn("secretos, tokens y datos de clientes nunca viven", decisions["D-062"]["text"])
        self.assertIn("ControlBot es el control plane", decisions["D-063"]["text"])
        self.assertIn("FactoryRunner es el execution plane", decisions["D-063"]["text"])
        self.assertIn("AutoFactory permanece independiente", decisions["D-063"]["text"])

    def test_dependabot_covers_npm_and_github_actions(self) -> None:
        text = (ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
        for ecosystem in ("npm", "github-actions"):
            pattern = (
                rf"(?ms)- package-ecosystem:\s*{re.escape(ecosystem)}\s+"
                r'directory:\s*["\']?/["\']?\s+'
                r"schedule:\s*\n\s*interval:\s*weekly"
            )
            self.assertRegex(text, pattern)
        self.assertEqual(2, text.count("package-ecosystem:"))
        self.assertNotIn("registries:", text)
        self.assertNotIn("password:", text)
        self.assertNotIn("token:", text)

    def test_readme_has_no_stale_private_visibility_blocker(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("El repositorio público es el estado canónico según D-062", text)
        self.assertNotIn("exige repositorio privado", text)
        self.assertNotIn("la visibilidad GitHub sigue siendo pública", text)
        self.assertIn("PII, credenciales, cookies y secretos siguen prohibidos", text)

    def test_post_bootstrap_work_queue_has_no_closed_now(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        queue = text.split("## Work Queue", 1)[1].split("\n## ", 1)[0]
        now_entry = next(
            line for line in queue.splitlines() if line.startswith("- **NOW:**")
        )
        self.assertIn("**NOW:** sin hoja disponible", now_entry)
        self.assertNotIn("sin Issues abiertos", now_entry)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues", now_entry)
        self.assertNotIn("#22", now_entry)
        for lane in ("NOW", "NEXT", "LATER", "BLOCKED"):
            self.assertIn(f"**{lane}:**", queue)

    def test_live_gate_431_is_a_blocked_issue_not_empty_queue(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        queue = text.split("## Work Queue", 1)[1].split("\n## ", 1)[0]
        now_entry = next(
            line for line in queue.splitlines() if line.startswith("- **NOW:**")
        )
        blocked_entry = next(
            line for line in queue.splitlines() if line.startswith("- **BLOCKED:**")
        )
        self.assertNotIn("sin Issues abiertos", queue)
        self.assertNotIn("**BLOCKED:** ninguno", queue)
        self.assertNotIn("#431", now_entry)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/431", blocked_entry)
        self.assertIn("puerta exclusiva del dueño", blocked_entry)
        self.assertIn("health/readiness", blocked_entry)
        self.assertIn("observabilidad y rollback", blocked_entry)
        self.assertIn("No representa una hoja disponible ni autoriza go-live", blocked_entry)

    def test_post_bootstrap_work_queue_points_to_canonical_issues(self) -> None:
        text = (ROOT / "README.md").read_text(encoding="utf-8")
        queue = text.split("## Work Queue", 1)[1].split("\n## ", 1)[0]
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues", queue)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/20", queue)
        self.assertIn("https://github.com/pl0n3r/Factory/issues/168", queue)

    def test_acceptance_caller_derives_issue_from_canonical_branch(self) -> None:
        text = (
            ROOT / ".github" / "workflows" / "aceptacion.yml"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "uses: pl0n3r/factory/.github/workflows/aceptacion.yml@v1",
            text,
        )
        self.assertRegex(text, r"(?m)^\s*issue_number:\s*0\s*$")


if __name__ == "__main__":
    unittest.main()
