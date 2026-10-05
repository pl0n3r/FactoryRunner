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
GIT_BINARY = "/usr/bin/git"
NODE_BINARY = shutil.which("node")
SNAPSHOT_FILENAME = ".factoryrunner-exact-main-source-snapshot.json"

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
    @classmethod
    def setUpClass(cls) -> None:
        if NODE_BINARY is None:
            raise unittest.SkipTest("node no está disponible")
        if not Path(GIT_BINARY).is_file():
            raise unittest.SkipTest("/usr/bin/git no está disponible")

    def _git(self, repo: Path, *arguments: str) -> str:
        completed = subprocess.run(
            [GIT_BINARY, "-C", str(repo), *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
            env={
                "PATH": "/usr/bin:/bin",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "LC_ALL": "C",
                "LANG": "C",
            },
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

    def _snapshot_path(self, repo: Path) -> Path:
        return repo.parent / SNAPSHOT_FILENAME

    def _run_snapshot(
        self,
        repo: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [NODE_BINARY, "--experimental-strip-types", str(SNAPSHOT)],
            cwd=repo,
            env={
                "PATH": "/usr/bin:/bin",
                "USER": "source-snapshot-secret-user-9f4c2e",
                "LC_ALL": "C",
                "LANG": "C",
            },
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
        self.assertIn("const git_binary = '/usr/bin/git';", source)
        self.assertIn("const trusted_path = '/usr/bin:/bin';", source)
        self.assertIn("const snapshot_filename = '.factoryrunner-exact-main-source-snapshot.json';", source)
        self.assertIn("spawnsync(\n    git_binary,", source)
        self.assertIn("git_config_nosystem: '1'", source)
        self.assertIn("git_config_global: '/dev/null'", source)
        self.assertIn("shell: false", source)
        self.assertNotIn("...process.env", source)
        self.assertNotIn("process.argv.slice", source)
        self.assertIn("process.argv.length !== 2", source)
        self.assertIn("entry !== package_source_paths[index]", source)
        self.assertIn(
            "'./execution-admission': './src/execution-admission-public.ts'",
            source,
        )
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
            repo = root / "positive" / "repo"
            repo.mkdir(parents=True)
            expected_paths = self._seed_repo(repo)
            output = self._snapshot_path(repo)

            self._run_snapshot(repo)
            first_body = output.read_text(encoding="utf-8")
            first_mode = output.stat().st_mode & 0o777

            exclusive = self._run_snapshot(repo, check=False)
            self.assertNotEqual(exclusive.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), first_body)

            output.unlink()
            self._run_snapshot(repo)
            second_body = output.read_text(encoding="utf-8")
            payload = json.loads(first_body)
            manifest = json.loads((repo / "package.json").read_text(encoding="utf-8"))

            self.assertEqual(first_body, second_body)
            self.assertEqual(first_body, json.dumps(payload, indent=2, sort_keys=True) + "\n")
            self.assertEqual(first_mode, 0o600)
            self.assertLessEqual(len(output.read_bytes()), 64 * 1024)
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

            dirty_repo = root / "dirty" / "repo"
            dirty_repo.mkdir(parents=True)
            dirty_paths = self._seed_repo(dirty_repo)
            dirty_target = dirty_repo / next(path for path in dirty_paths if path.startswith("src/"))
            dirty_target.write_text(
                dirty_target.read_text(encoding="utf-8") + "\n// dirty\n",
                encoding="utf-8",
            )
            dirty = self._run_snapshot(dirty_repo, check=False)
            self.assertNotEqual(dirty.returncode, 0)
            self.assertFalse(self._snapshot_path(dirty_repo).exists())

            detached_repo = root / "detached" / "repo"
            detached_repo.mkdir(parents=True)
            self._seed_repo(detached_repo)
            self._git(detached_repo, "checkout", "--detach", "HEAD")
            detached = self._run_snapshot(detached_repo, check=False)
            self.assertNotEqual(detached.returncode, 0)
            self.assertFalse(self._snapshot_path(detached_repo).exists())

            export_drift_repo = root / "export-drift" / "repo"
            export_drift_repo.mkdir(parents=True)
            self._seed_repo(export_drift_repo)
            export_manifest_path = export_drift_repo / "package.json"
            export_manifest = json.loads(
                export_manifest_path.read_text(encoding="utf-8")
            )
            export_manifest["exports"]["./unexpected"] = "./src/browser-plan.ts"
            export_manifest_path.write_text(
                json.dumps(export_manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            self._git(export_drift_repo, "add", "--all")
            self._git(export_drift_repo, "commit", "-m", "fixture: export drift")
            export_drift = self._run_snapshot(export_drift_repo, check=False)
            self.assertNotEqual(export_drift.returncode, 0)
            self.assertFalse(self._snapshot_path(export_drift_repo).exists())

            sensitive_repo = root / "sensitive" / "repo"
            sensitive_repo.mkdir(parents=True)
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

            sensitive = self._run_snapshot(sensitive_repo, check=False)
            self.assertNotEqual(sensitive.returncode, 0)
            self.assertFalse(self._snapshot_path(sensitive_repo).exists())


if __name__ == "__main__":
    unittest.main()
