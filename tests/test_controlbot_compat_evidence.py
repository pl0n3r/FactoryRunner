"""Factory v1 acceptance adapter: delegates to exact Node/TypeScript tests offline."""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST = ROOT / "tests" / "controlbot-compat-evidence.test.ts"


class ControlBotCompatEvidenceTests(unittest.TestCase):
    def _node_test(self, pattern):
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test", "--test-reporter=tap",
             f"--test-name-pattern={pattern}", str(TEST)],
            cwd=ROOT, capture_output=True, text=True, timeout=25, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)
        self.assertIn("# pass 1", result.stdout, "Acceptance target must execute its named test")

    def test_versions_and_exact_sha(self):
        self._node_test("versions and exact SHA of both source repositories are reported separately")

    def test_incompatibility_is_no_go(self):
        self._node_test("a route mismatch is detailed and produces NO_GO")

    def test_no_credentials_or_writes(self):
        self._node_test("fixture evaluation is offline, redacted, and never writes or uses credentials")
