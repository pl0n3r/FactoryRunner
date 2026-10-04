import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
BUILDER = SCRIPTS / "build-observability-package.ts"
PROVENANCE = SCRIPTS / "build-observability-package-provenance.ts"
DEPENDENCIES = SCRIPTS / "build-observability-package-dependency-evidence.ts"
PREFLIGHT = SCRIPTS / "check-observability-package-release-preflight.ts"
LOCKFILE = ROOT / "package-lock.json"


class FactoryRunnerObservabilityPackageReleasePreflightTests(unittest.TestCase):
    def _node(
        self,
        script: Path,
        *arguments: str,
        check: bool = True,
        cwd: Path = ROOT,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", "--experimental-strip-types", str(script), *arguments],
            cwd=cwd,
            env=env,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def _release_fixture(
        self,
        root: Path,
        *,
        runtime_dependency: bool = False,
    ) -> tuple[Path, Path, Path]:
        stage = root / "stage"
        self._node(BUILDER, "--output", str(stage))

        lockfile = LOCKFILE
        if runtime_dependency:
            manifest_path = stage / "package.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["dependencies"] = {"example-runtime": "^1.2.0"}
            manifest_path.write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf-8",
            )

            lock_payload = json.loads(LOCKFILE.read_text(encoding="utf-8"))
            lock_payload["packages"][""]["dependencies"] = {
                "example-runtime": "^1.2.0"
            }
            lock_payload["packages"]["node_modules/example-runtime"] = {
                "version": "1.2.3"
            }
            lockfile = root / "runtime-package-lock.json"
            lockfile.write_text(
                json.dumps(lock_payload, indent=2) + "\n",
                encoding="utf-8",
            )

        pack = root / "pack"
        pack.mkdir()
        npm_env = {
            **os.environ,
            "npm_config_offline": "true",
            "npm_config_ignore_scripts": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
            "npm_config_update_notifier": "false",
            "npm_config_cache": str(root / "npm-cache"),
        }
        packed = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--offline",
                "--ignore-scripts",
                "--pack-destination",
                str(pack),
                ".",
            ],
            cwd=stage,
            env=npm_env,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        pack_result = json.loads(packed.stdout)
        self.assertEqual(len(pack_result), 1)
        artifact = pack / pack_result[0]["filename"]

        provenance = root / "provenance.json"
        self._node(
            PROVENANCE,
            "--tarball",
            str(artifact),
            "--stage",
            str(stage),
            "--output",
            str(provenance),
        )

        dependencies = root / "dependencies.json"
        self._node(
            DEPENDENCIES,
            "--manifest",
            str(stage / "package.json"),
            "--lockfile",
            str(lockfile),
            "--output",
            str(dependencies),
        )
        return artifact, provenance, dependencies

    def _check(
        self,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return self._node(
            PREFLIGHT,
            "--artifact",
            str(artifact),
            "--provenance",
            str(provenance),
            "--dependencies",
            str(dependencies),
            check=check,
        )

    def test_preflight_accepts_exact_local_artifact_with_matching_provenance_and_dependencies(
        self,
    ) -> None:
        source = PREFLIGHT.read_text(encoding="utf-8").lower()
        self.assertTrue(
            all(
                token not in source
                for token in (
                    "node:http",
                    "node:https",
                    "fetch(",
                    "child_process",
                    "npm publish",
                    "npm login",
                    "npm view",
                    "--registry",
                )
            )
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies = self._release_fixture(root)
            frozen = {
                "artifact": artifact.read_bytes(),
                "provenance": provenance.read_bytes(),
                "dependencies": dependencies.read_bytes(),
            }

            completed = self._check(artifact, provenance, dependencies)
            result = json.loads(completed.stdout)
            dependency_payload = json.loads(dependencies.read_text(encoding="utf-8"))

            self.assertIs(result["accepted"], True)
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(frozen["artifact"]).hexdigest(),
            )
            self.assertEqual(result["package"], dependency_payload["package"])
            self.assertIs(result["runtime_evidence_bound"], True)
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)
            self.assertEqual(artifact.read_bytes(), frozen["artifact"])
            self.assertEqual(provenance.read_bytes(), frozen["provenance"])
            self.assertEqual(dependencies.read_bytes(), frozen["dependencies"])

    def test_preflight_rejects_drift_tampering_or_publish_network_authority(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies = self._release_fixture(root)

            tampered_artifact = root / artifact.name
            tampered_artifact.write_bytes(artifact.read_bytes() + b"tamper")
            self.assertNotEqual(
                self._check(
                    tampered_artifact,
                    provenance,
                    dependencies,
                    check=False,
                ).returncode,
                0,
            )

            base_provenance = json.loads(provenance.read_text(encoding="utf-8"))
            base_dependencies = json.loads(dependencies.read_text(encoding="utf-8"))
            cases: list[tuple[str, dict, dict]] = []

            networked = copy.deepcopy(base_provenance)
            networked["network_access"] = True
            cases.append(("networked", networked, base_dependencies))

            drifted = copy.deepcopy(base_dependencies)
            drifted["source"]["manifest_sha256"] = "0" * 64
            cases.append(("manifest-drift", base_provenance, drifted))

            forged_provenance = copy.deepcopy(base_provenance)
            forged_dependencies = copy.deepcopy(base_dependencies)
            forged_sha = "a" * 64
            for item in forged_provenance["files"]:
                if item["path"] == "package.json":
                    item["sha256"] = forged_sha
            forged_dependencies["source"]["manifest_sha256"] = forged_sha
            cases.append(("forged-cross-evidence", forged_provenance, forged_dependencies))

            synthetic_runtime = copy.deepcopy(base_dependencies)
            synthetic_runtime["runtime_dependencies"] = [
                {
                    "name": "synthetic-runtime",
                    "specifier": "1.0.0",
                    "locked_version": "1.0.0",
                }
            ]
            cases.append(("synthetic-runtime", base_provenance, synthetic_runtime))

            partial = copy.deepcopy(base_provenance)
            partial["files"] = [
                item for item in partial["files"] if item["path"] != "package.json"
            ]
            cases.append(("partial", partial, base_dependencies))

            forged_files = copy.deepcopy(base_provenance)
            forged_target = next(
                item
                for item in forged_files["files"]
                if item["path"] != "package.json"
            )
            forged_target["sha256"] = "f" * 64
            cases.append(("forged-internal-file", forged_files, base_dependencies))

            authority = copy.deepcopy(base_dependencies)
            authority["registry_authority"] = {
                "enabled": True,
                "token": "must-never-be-accepted",
            }
            cases.append(("authority", base_provenance, authority))

            for label, provenance_payload, dependency_payload in cases:
                with self.subTest(label=label):
                    provenance_path = root / f"{label}-provenance.json"
                    dependency_path = root / f"{label}-dependencies.json"
                    provenance_path.write_text(
                        json.dumps(provenance_payload, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    dependency_path.write_text(
                        json.dumps(dependency_payload, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    self.assertNotEqual(
                        self._check(
                            artifact,
                            provenance_path,
                            dependency_path,
                            check=False,
                        ).returncode,
                        0,
                    )

    def test_preflight_rejects_locked_version_outside_runtime_specifier(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies = self._release_fixture(
                root,
                runtime_dependency=True,
            )

            valid = self._check(artifact, provenance, dependencies)
            self.assertEqual(valid.returncode, 0)

            payload = json.loads(dependencies.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["runtime_dependencies"],
                [
                    {
                        "name": "example-runtime",
                        "specifier": "^1.2.0",
                        "locked_version": "1.2.3",
                    }
                ],
            )
            payload["runtime_dependencies"][0]["locked_version"] = "9.0.0"
            outside = root / "outside-range-dependencies.json"
            outside.write_text(
                json.dumps(payload, sort_keys=True) + "\n",
                encoding="utf-8",
            )

            rejected = self._check(
                artifact,
                provenance,
                outside,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == "__main__":
    unittest.main()
