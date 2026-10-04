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

    def _release_fixture(self, root: Path) -> tuple[Path, Path, Path]:
        stage = root / "stage"
        self._node(BUILDER, "--output", str(stage))

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
            str(LOCKFILE),
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

            partial = copy.deepcopy(base_provenance)
            partial["files"] = [
                item for item in partial["files"] if item["path"] != "package.json"
            ]
            cases.append(("partial", partial, base_dependencies))

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


if __name__ == "__main__":
    unittest.main()
