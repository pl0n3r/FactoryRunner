import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "etiquetas.yml"


class EtiquetasWorkflowPermissionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def _job_block(self, job: str) -> str:
        match = re.search(
            rf"(?ms)^  {re.escape(job)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
            self.text,
        )
        self.assertIsNotNone(match, job)
        return match.group(0)

    def test_only_pr_validation_requests_pull_requests_write(self) -> None:
        validar_pr = self._job_block("validar-pr")
        self.assertRegex(validar_pr, r"(?m)^      pull-requests: write$")
        self.assertEqual(1, self.text.count("pull-requests: write"))

        for job in ("sync", "validar-issue", "sweep"):
            block = self._job_block(job)
            self.assertRegex(block, r"(?m)^      pull-requests: read$")
            self.assertNotIn("pull-requests: write", block)

    def test_non_pr_jobs_remain_read_only_and_factory_v1_is_preserved(self) -> None:
        reusable = "uses: pl0n3r/factory/.github/workflows/etiquetas.yml@v1"
        self.assertEqual(4, self.text.count(reusable))
        self.assertNotIn("contents: write", self.text)
        self.assertNotIn("secrets: inherit", self.text)

        for job in ("sync", "validar-issue", "validar-pr", "sweep"):
            block = self._job_block(job)
            self.assertRegex(block, r"(?m)^      contents: read$")
            self.assertRegex(block, r"(?m)^      issues: write$")
            self.assertIn(reusable, block)


if __name__ == "__main__":
    unittest.main()
