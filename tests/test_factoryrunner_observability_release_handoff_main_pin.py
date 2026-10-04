import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "create-observability-release-handoff-main-pin.ts"
NODE_BINARY = shutil.which("node")


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


class FactoryRunnerObservabilityReleaseHandoffMainPinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE_BINARY is None:
            raise unittest.SkipTest("node no está disponible")

    def _run(
        self,
        commit: str,
        tree: str,
        output: Path,
        *,
        check: bool = True,
        extra: list[str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            NODE_BINARY,
            "--experimental-strip-types",
            str(BUILDER),
            "--commit-sha",
            commit,
            "--tree-sha",
            tree,
            "--output",
            str(output),
        ]
        if extra:
            command.extend(extra)
        env = os.environ.copy()
        env["USER"] = "main-pin-secret-user-84c2f1"
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{BUILDER.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_main_pin_binds_commit_and_tree_without_network_or_authority(self) -> None:
        source = BUILDER.read_text(encoding="utf-8").lower()
        self.assertNotIn("process.env", source)
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "github.com",
            "git fetch",
            "git pull",
            "git push",
            "npm publish",
            "curl ",
            "wget ",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commit = "1" * 40
            tree = "2" * 40
            first = root / "pin-a.json"
            second = root / "pin-b.json"

            self._run(commit, tree, first)
            self._run(commit, tree, second)

            first_body = first.read_bytes()
            self.assertEqual(first_body, second.read_bytes())
            payload = json.loads(first_body)
            self.assertEqual(first_body.decode("utf-8"), canonical(payload))
            self.assertLessEqual(len(first_body), 1024)
            self.assertEqual(first.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                payload,
                {
                    "authority": "unchanged",
                    "external_mutation": False,
                    "network_access": False,
                    "publish_authority": False,
                    "repository": {
                        "commit_sha": commit,
                        "ref": "refs/heads/main",
                        "tree_sha": tree,
                    },
                    "schema_version": 1,
                    "verification": {"current_main_explicit": True},
                },
            )

            lowered = first.read_text(encoding="utf-8").lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("main-pin-secret-user-84c2f1", lowered)

            existing = self._run(commit, tree, first, check=False)
            self.assertNotEqual(existing.returncode, 0)
            self.assertEqual(first.read_bytes(), first_body)

    def test_invalid_mixed_or_unknown_main_pin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = (
                ("A" * 40, "2" * 40, "uppercase"),
                ("1" * 39, "2" * 40, "short"),
                ("0" * 40, "2" * 40, "unknown-commit"),
                ("1" * 40, "0" * 40, "unknown-tree"),
                ("3" * 40, "3" * 40, "mixed"),
            )
            for commit, tree, name in cases:
                with self.subTest(name=name):
                    output = root / f"{name}.json"
                    rejected = self._run(commit, tree, output, check=False)
                    self.assertNotEqual(rejected.returncode, 0)
                    self.assertFalse(output.exists())

            output = root / "unknown-flag.json"
            rejected = self._run(
                "1" * 40,
                "2" * 40,
                output,
                check=False,
                extra=["--unknown", "value"],
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
