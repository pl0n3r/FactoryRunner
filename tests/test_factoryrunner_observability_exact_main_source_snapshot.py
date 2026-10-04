import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "scripts" / "create-observability-exact-main-source-snapshot.ts"

RELEASE_SUPPORT_PATHS = (
    "README.md",
    "package-lock.json",
    "package.json",
    "scripts/build-observability-package-dependency-evidence.ts",
    "scripts/build-observability-package-provenance.ts",
    "scripts/build-observability-package.ts",
    "scripts/check-observability-package-release-preflight.ts",
    "scripts/check-observability-package-release-receipt.ts",
    "scripts/check-observability-package-verified-consumer.ts",
    "scripts/create-observability-package-release-receipt.ts",
)


class FactoryRunnerObservabilityExactMainSourceSnapshotTests(unittest.TestCase):
    def _git(self, repo: Path, *arguments: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(repo), *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return completed.stdout.strip()

    def _release_paths(self) -> list[str]:
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        return sorted(set(RELEASE_SUPPORT_PATHS).union(manifest["files"]))

    def _seed_repo(self, repo: Path) -> list[str]:
        paths = self._release_paths()
        for relative in paths:
            source = ROOT / relative
            target = repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

        self._git(repo, "init", "-b", "main")
        self._git(repo, "config", "user.name", "FactoryRunner Tests")
        self._git(repo, "config", "user.email", "factoryrunner-tests@example.invalid")
        self._git(repo, "add", "--all")
        self._git(repo, "commit", "-m", "fixture: exact main release source")
        return paths

    def _run_snapshot(
        self,
        repo: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "source-snapshot-secret-user-9f4c2e"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(SNAPSHOT),
                "--repo",
                str(repo),
                "--output",
                str(output),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{SNAPSHOT.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_snapshot_binds_exact_commit_tree_and_allowlisted_release_sources_deterministically(
        self,
    ) -> None:
        source = SNAPSHOT.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "git fetch",
            "git pull",
            "git push",
            "npm publish",
            "curl ",
            "wget ",
            "registry.npmjs.org",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            expected_paths = self._seed_repo(repo)

            first = root / "snapshot-a.json"
            second = root / "snapshot-b.json"
            self._run_snapshot(repo, first)
            self._run_snapshot(repo, second)

            first_body = first.read_text(encoding="utf-8")
            second_body = second.read_text(encoding="utf-8")
            payload = json.loads(first_body)
            manifest = json.loads((repo / "package.json").read_text(encoding="utf-8"))

            self.assertEqual(first_body, second_body)
            self.assertEqual(first_body, json.dumps(payload, indent=2, sort_keys=True) + "\n")
            self.assertLessEqual(len(first.read_bytes()), 64 * 1024)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(
                payload["package"],
                {
                    "name": manifest["name"],
                    "version": manifest["version"],
                    "private": True,
                    "type": "module",
                },
            )
            self.assertEqual(payload["repository"]["ref"], "refs/heads/main")
            self.assertEqual(payload["repository"]["commit_sha"], self._git(repo, "rev-parse", "HEAD"))
            self.assertEqual(
                payload["repository"]["tree_sha"],
                self._git(repo, "rev-parse", "HEAD^{tree}"),
            )

            files = payload["source"]["files"]
            self.assertEqual([entry["path"] for entry in files], expected_paths)
            for entry in files:
                body = (repo / entry["path"]).read_bytes()
                self.assertEqual(entry["size"], len(body))
                self.assertEqual(entry["sha256"], hashlib.sha256(body).hexdigest())

            canonical_files = json.dumps(files, indent=2, sort_keys=True) + "\n"
            self.assertEqual(
                payload["source"]["sha256"],
                hashlib.sha256(canonical_files.encode("utf-8")).hexdigest(),
            )
            self.assertEqual(
                payload["verification"],
                {
                    "exact_main": True,
                    "tracked_sources": True,
                    "worktree_clean": True,
                },
            )
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = first_body.lower()
            self.assertNotIn(str(repo).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("source-snapshot-secret-user-9f4c2e", lowered)
            self.assertNotIn("http://", lowered)
            self.assertNotIn("https://", lowered)
            self.assertNotIn("timestamp", lowered)
            self.assertNotIn("created_at", lowered)

    def test_dirty_ambiguous_or_sensitive_source_state_fails_closed_without_network(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            dirty_repo = root / "dirty"
            dirty_repo.mkdir()
            dirty_paths = self._seed_repo(dirty_repo)
            dirty_target = dirty_repo / next(path for path in dirty_paths if path.startswith("src/"))
            dirty_target.write_text(
                dirty_target.read_text(encoding="utf-8") + "\n// dirty\n",
                encoding="utf-8",
            )
            dirty_output = root / "dirty.json"
            dirty = self._run_snapshot(dirty_repo, dirty_output, check=False)
            self.assertNotEqual(dirty.returncode, 0)
            self.assertFalse(dirty_output.exists())

            detached_repo = root / "detached"
            detached_repo.mkdir()
            self._seed_repo(detached_repo)
            self._git(detached_repo, "checkout", "--detach", "HEAD")
            detached_output = root / "detached.json"
            detached = self._run_snapshot(detached_repo, detached_output, check=False)
            self.assertNotEqual(detached.returncode, 0)
            self.assertFalse(detached_output.exists())

            sensitive_repo = root / "sensitive"
            sensitive_repo.mkdir()
            self._seed_repo(sensitive_repo)
            manifest_path = sensitive_repo / "package.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"].append("src/secrets.ts")
            manifest["files"] = sorted(manifest["files"])
            manifest_path.write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            secret_path = sensitive_repo / "src" / "secrets.ts"
            secret_path.write_text("export const secret = 'do-not-snapshot';\n", encoding="utf-8")
            self._git(sensitive_repo, "add", "--all")
            self._git(sensitive_repo, "commit", "-m", "fixture: sensitive source path")

            sensitive_output = root / "sensitive.json"
            sensitive = self._run_snapshot(sensitive_repo, sensitive_output, check=False)
            self.assertNotEqual(sensitive.returncode, 0)
            self.assertFalse(sensitive_output.exists())


if __name__ == "__main__":
    unittest.main()
