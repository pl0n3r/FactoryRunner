import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
DEPENDENCY_EVIDENCE = (
    ROOT / "scripts" / "build-observability-package-dependency-evidence.ts"
)
LOCKFILE = ROOT / "package-lock.json"


class FactoryRunnerObservabilityPackageDependenciesTests(unittest.TestCase):
    def _build_stage(self, root: Path) -> Path:
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
        return stage

    def _evidence(
        self,
        manifest: Path,
        lockfile: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["npm_config_offline"] = "true"
        return subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(DEPENDENCY_EVIDENCE),
                "--manifest",
                str(manifest),
                "--lockfile",
                str(lockfile),
                "--output",
                str(output),
            ],
            cwd=ROOT,
            env=env,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_dependency_evidence_is_derived_only_from_lockfile_and_packaged_manifest(
        self,
    ) -> None:
        source = DEPENDENCY_EVIDENCE.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm install",
            "npm view",
            "npm publish",
            "registry.npmjs.org",
            "child_process",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = self._build_stage(root)
            manifest_path = stage / "package.json"
            output_a = root / "dependencies-a.json"
            output_b = root / "dependencies-b.json"

            self._evidence(manifest_path, LOCKFILE, output_a)
            self._evidence(manifest_path, LOCKFILE, output_b)

            body_a = output_a.read_text(encoding="utf-8")
            body_b = output_b.read_text(encoding="utf-8")
            payload = json.loads(body_a)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(body_a, body_b)
            self.assertEqual(
                body_a,
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
            )
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
            self.assertEqual(payload["runtime_dependencies"], [])
            self.assertEqual(payload["source"]["lockfile_version"], 3)
            self.assertEqual(
                payload["source"]["manifest_sha256"],
                hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                payload["source"]["lockfile_sha256"],
                hashlib.sha256(LOCKFILE.read_bytes()).hexdigest(),
            )
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = body_a.lower()
            self.assertNotIn("https://registry.npmjs.org", lowered)
            self.assertNotIn("resolved", lowered)
            self.assertNotIn("@types/node", lowered)
            self.assertNotIn("typescript", lowered)
            self.assertNotIn("undici-types", lowered)
            self.assertNotIn(str(root).lower(), lowered)

            synthetic_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            synthetic_manifest["dependencies"] = {
                "example-runtime": "^1.2.0"
            }
            synthetic_manifest_path = root / "synthetic-package.json"
            synthetic_manifest_path.write_text(
                json.dumps(synthetic_manifest, indent=2) + "\n",
                encoding="utf-8",
            )

            synthetic_lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
            synthetic_lock["packages"][""]["dependencies"] = {
                "example-runtime": "^1.2.0"
            }
            synthetic_lock["packages"]["node_modules/example-runtime"] = {
                "version": "1.2.3",
                "resolved": (
                    "https://registry.npmjs.org/example-runtime/"
                    "-/example-runtime-1.2.3.tgz"
                ),
                "integrity": "sha512-not-exported",
            }
            synthetic_lock_path = root / "synthetic-lock.json"
            synthetic_lock_path.write_text(
                json.dumps(synthetic_lock, indent=2) + "\n",
                encoding="utf-8",
            )

            synthetic_output = root / "synthetic-evidence.json"
            self._evidence(
                synthetic_manifest_path,
                synthetic_lock_path,
                synthetic_output,
            )
            synthetic = json.loads(
                synthetic_output.read_text(encoding="utf-8")
            )
            self.assertEqual(
                synthetic["runtime_dependencies"],
                [
                    {
                        "name": "example-runtime",
                        "specifier": "^1.2.0",
                        "locked_version": "1.2.3",
                    }
                ],
            )
            self.assertNotIn(
                "registry.npmjs.org",
                synthetic_output.read_text(encoding="utf-8").lower(),
            )

    def test_unknown_or_drifting_dependency_metadata_fails_closed_without_network(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = self._build_stage(root)
            base_manifest = json.loads(
                (stage / "package.json").read_text(encoding="utf-8")
            )

            unknown_manifest = dict(base_manifest)
            unknown_manifest["dependencies"] = {
                "missing-runtime": "^9.0.0"
            }
            unknown_path = root / "unknown-package.json"
            unknown_path.write_text(
                json.dumps(unknown_manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            unknown_output = root / "unknown.json"
            failed_unknown = self._evidence(
                unknown_path,
                LOCKFILE,
                unknown_output,
                check=False,
            )
            self.assertNotEqual(failed_unknown.returncode, 0)
            self.assertFalse(unknown_output.exists())

            drift_manifest = dict(base_manifest)
            drift_manifest["dependencies"] = {
                "example-runtime": "^1.2.0"
            }
            drift_manifest_path = root / "drift-package.json"
            drift_manifest_path.write_text(
                json.dumps(drift_manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            drift_lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
            drift_lock["packages"][""]["dependencies"] = {
                "example-runtime": "^2.0.0"
            }
            drift_lock["packages"]["node_modules/example-runtime"] = {
                "version": "2.0.1"
            }
            drift_lock_path = root / "drift-lock.json"
            drift_lock_path.write_text(
                json.dumps(drift_lock, indent=2) + "\n",
                encoding="utf-8",
            )
            drift_output = root / "drift.json"
            failed_drift = self._evidence(
                drift_manifest_path,
                drift_lock_path,
                drift_output,
                check=False,
            )
            self.assertNotEqual(failed_drift.returncode, 0)
            self.assertFalse(drift_output.exists())

            local_manifest = dict(base_manifest)
            local_manifest["dependencies"] = {
                "local-runtime": "file:../local-runtime"
            }
            local_path = root / "local-package.json"
            local_path.write_text(
                json.dumps(local_manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            local_output = root / "local.json"
            failed_local = self._evidence(
                local_path,
                LOCKFILE,
                local_output,
                check=False,
            )
            self.assertNotEqual(failed_local.returncode, 0)
            self.assertFalse(local_output.exists())

            dev_manifest = dict(base_manifest)
            dev_manifest["devDependencies"] = {
                "unexpected-build-tool": "1.0.0"
            }
            dev_path = root / "dev-package.json"
            dev_path.write_text(
                json.dumps(dev_manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            dev_output = root / "dev.json"
            failed_dev = self._evidence(
                dev_path,
                LOCKFILE,
                dev_output,
                check=False,
            )
            self.assertNotEqual(failed_dev.returncode, 0)
            self.assertFalse(dev_output.exists())


if __name__ == "__main__":
    unittest.main()
