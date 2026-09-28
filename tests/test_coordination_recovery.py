import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "coordinacion.yml"


class CoordinationRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def _reusable_job_blocks(self) -> list[str]:
        matches = list(
            re.finditer(
                r"(?ms)^  ([A-Za-z0-9_-]+):\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
                self.text,
            )
        )
        return [
            match.group(0)
            for match in matches
            if "uses: pl0n3r/factory/.github/workflows/coordinacion.yml@v1" in match.group(0)
        ]

    def test_caller_grants_checks_write_to_reusable_jobs(self) -> None:
        blocks = self._reusable_job_blocks()
        self.assertEqual(6, len(blocks))
        for block in blocks:
            self.assertRegex(block, r"(?m)^      checks: write$")

    def test_caller_routes_renew_contract_command(self) -> None:
        command = "startsWith(github.event.comment.body, '/renovar-contrato ')"
        self.assertIn(command, self.text)
        self.assertEqual(1, self.text.count(command))

    def test_caller_matches_factory_v1_shape(self) -> None:
        self.assertIn("name: Coordinación", self.text)
        self.assertIn("cancel-in-progress: false", self.text)
        reusable = "uses: pl0n3r/factory/.github/workflows/coordinacion.yml@v1"
        self.assertEqual(6, self.text.count(reusable))
        for operation in ("comment", "label", "pr", "validate", "issue", "sweep"):
            self.assertIn(f"operation: {operation}", self.text)

    def test_issue_preserves_real_v2_reservation_marker(self) -> None:
        # The reservation itself is operational evidence on FactoryRunner#5.
        # This regression protects the caller path that creates that marker.
        self.assertIn("github.event.comment.body == '/tomar'", self.text)
        self.assertIn("operation: comment", self.text)
        self.assertIn("issue_number: ${{ github.event.issue.number }}", self.text)
        self.assertIn("actor: ${{ github.event.comment.user.login }}", self.text)
        self.assertIn("association: ${{ github.event.comment.author_association }}", self.text)
        self.assertIn("body: ${{ github.event.comment.body }}", self.text)

    def test_repair_scope_excludes_runtime_paths(self) -> None:
        forbidden = (
            "src/",
            "package.json",
            "package-lock.json",
            "browser",
            "database",
            "secrets:",
        )
        lowered = self.text.lower()
        for value in forbidden:
            self.assertNotIn(value.lower(), lowered)


if __name__ == "__main__":
    unittest.main()
