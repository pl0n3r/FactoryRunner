import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
PROVENANCE = ROOT / "scripts" / "build-observability-package-provenance.ts"
DEPENDENCIES = ROOT / "scripts" / "build-observability-package-dependency-evidence.ts"
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
LOCKFILE = ROOT / "package-lock.json"


class FactoryRunnerObservabilityPackageReleasePreflightTests(unittest.TestCase):
    def _npm_env(self, cache: Path) -> dict[str, str]:
        cache.mkdir()
        env = os.environ.copy()
        env.update(
            {
                "npm_config_offline": "true",
                "npm_config_ignore_scripts": "true",
                "npm_config_audit": "false",
                "npm_config_fund": "false",
                "npm_config_update_notifier": "false",
                "npm_config_cache": str(cache),
            }
        )
        return env

    def _build_release_evidence(
        self,
        root: Path,
    ) -> tuple[Path, Path, Path, Path]:
        stage = root / "stage"
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BUILDER),
                "--output",
                str(stage),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        pack = root / "pack"
        pack.mkdir()
        completed = subprocess.run(
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
            env=self._npm_env(root / "npm-cache"),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, list)
        self.assertEqual(len(payload), 1)
        tarball = pack / payload[0]["filename"]
        self.assertTrue(tarball.is_file())

        provenance = root / "provenance.json"
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(PROVENANCE),
                "--tarball",
                str(tarball),
                "--stage",
                str(stage),
                "--output",
                str(provenance),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        dependencies = root / "dependencies.json"
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(DEPENDENCIES),
                "--manifest",
                str(stage / "package.json"),
                "--lockfile",
                str(LOCKFILE),
                "--output",
                str(dependencies),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return stage, tarball, provenance, dependencies

    def _preflight(
        self,
        tarball: Path,
        provenance: Path,
        dependencies: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(PREFLIGHT),
                "--artifact",
                str(tarball),
                "--provenance",
                str(provenance),
                "--dependencies",
                str(dependencies),
            ],
            cwd=ROOT,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_preflight_accepts_exact_local_artifact_with_matching_provenance_and_dependencies(
        self,
    ) -> None:
        source = PREFLIGHT.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "child_process",
            "npm publish",
            "npm login",
            "npm view",
            "--registry",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, tarball, provenance, dependencies = self._build_release_evidence(root)
            provenance_before = provenance.read_bytes()
            dependencies_before = dependencies.read_bytes()
            artifact_before = tarball.read_bytes()

            completed = self._preflight(tarball, provenance, dependencies)
            result = json.loads(completed.stdout)

            self.assertEqual(
                result,
                {
                    "accepted": True,
                    "artifact_sha256": hashlib.sha256(artifact_before).hexdigest(),
                    "package": {
                        "name": "@pl0n3r/factoryrunner",
                        "version": "0.1.0",
                        "private": True,
                        "type": "module",
                    },
                    "runtime_evidence_bound": True,
                    "network_access": False,
                    "external_mutation": False,
                },
            )
            self.assertEqual(tarball.read_bytes(), artifact_before)
            self.assertEqual(provenance.read_bytes(), provenance_before)
            self.assertEqual(dependencies.read_bytes(), dependencies_before)

    def test_preflight_rejects_drift_tampering_or_publish_network_authority(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, tarball, provenance, dependencies = self._build_release_evidence(root)

            tampered_artifact = root / tarball.name
            tampered_artifact.write_bytes(tarball.read_bytes() + b"tamper")
            artifact_failed = self._preflight(
                tampered_artifact,
                provenance,
                dependencies,
                check=False,
            )
            self.assertNotEqual(artifact_failed.returncode, 0)

            provenance_payload = json.loads(provenance.read_text(encoding="utf-8"))
            provenance_payload["network_access"] = True
            bad_provenance = root / "bad-provenance.json"
            bad_provenance.write_text(
                json.dumps(provenance_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            provenance_failed = self._preflight(
                tarball,
                bad_provenance,
                dependencies,
                check=False,
            )
            self.assertNotEqual(provenance_failed.returncode, 0)

            dependency_payload = json.loads(dependencies.read_text(encoding="utf-8"))
            dependency_payload["source"]["manifest_sha256"] = "0" * 64
            bad_dependencies = root / "bad-dependencies.json"
            bad_dependencies.write_text(
                json.dumps(dependency_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            dependency_failed = self._preflight(
                tarball,
                provenance,
                bad_dependencies,
                check=False,
            )
            self.assertNotEqual(dependency_failed.returncode, 0)

            partial_payload = copy.deepcopy(json.loads(provenance.read_text(encoding="utf-8")))
            partial_payload["files"] = [
                item
                for item in partial_payload["files"]
                if item["path"] != "package.json"
            ]
            partial_provenance = root / "partial-provenance.json"
            partial_provenance.write_text(
                json.dumps(partial_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            partial_failed = self._preflight(
                tarball,
                partial_provenance,
                dependencies,
                check=False,
            )
            self.assertNotEqual(partial_failed.returncode, 0)

            authority_payload = json.loads(dependencies.read_text(encoding="utf-8"))
            authority_payload["registry_authority"] = {
                "enabled": True,
                "token": "must-never-be-accepted",
            }
            authority_dependencies = root / "authority-dependencies.json"
            authority_dependencies.write_text(
                json.dumps(authority_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            authority_failed = self._preflight(
                tarball,
                provenance,
                authority_dependencies,
                check=False,
            )
            self.assertNotEqual(authority_failed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
