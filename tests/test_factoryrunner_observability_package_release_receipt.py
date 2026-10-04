import hashlib
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
PROVENANCE = ROOT / "scripts" / "build-observability-package-provenance.ts"
DEPENDENCIES = ROOT / "scripts" / "build-observability-package-dependency-evidence.ts"
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
RECEIPT = ROOT / "scripts" / "create-observability-package-release-receipt.ts"
LOCKFILE = ROOT / "package-lock.json"


class FactoryRunnerObservabilityPackageReleaseReceiptTests(unittest.TestCase):
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

    def _run_node(
        self,
        script: Path,
        *arguments: str,
        check: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(script),
                *arguments,
            ],
            cwd=ROOT,
            env=env,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def _build_evidence(
        self,
        root: Path,
    ) -> tuple[Path, Path, Path, Path]:
        stage = root / "stage"
        self._run_node(BUILDER, "--output", str(stage))

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
        packed = json.loads(completed.stdout)
        self.assertEqual(len(packed), 1)
        tarball = pack / packed[0]["filename"]
        self.assertTrue(tarball.is_file())

        provenance = root / "provenance.json"
        self._run_node(
            PROVENANCE,
            "--tarball",
            str(tarball),
            "--stage",
            str(stage),
            "--output",
            str(provenance),
        )

        dependencies = root / "dependencies.json"
        self._run_node(
            DEPENDENCIES,
            "--manifest",
            str(stage / "package.json"),
            "--lockfile",
            str(LOCKFILE),
            "--output",
            str(dependencies),
        )
        return stage, tarball, provenance, dependencies

    def _preflight(
        self,
        tarball: Path,
        provenance: Path,
        dependencies: Path,
    ) -> subprocess.CompletedProcess[str]:
        return self._run_node(
            PREFLIGHT,
            "--artifact",
            str(tarball),
            "--provenance",
            str(provenance),
            "--dependencies",
            str(dependencies),
        )

    def _receipt(
        self,
        tarball: Path,
        provenance: Path,
        dependencies: Path,
        output: Path,
        *,
        preflight: Path = PREFLIGHT,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "release-receipt-secret-user-8d2f9a"
        env["npm_config_offline"] = "true"
        return self._run_node(
            RECEIPT,
            "--artifact",
            str(tarball),
            "--provenance",
            str(provenance),
            "--dependencies",
            str(dependencies),
            "--preflight",
            str(preflight),
            "--output",
            str(output),
            check=check,
            env=env,
        )

    def test_receipt_binds_exact_artifact_provenance_dependencies_and_preflight_fingerprints(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, tarball, provenance, dependencies = self._build_evidence(root)
            preflight = self._preflight(tarball, provenance, dependencies)
            preflight_result = json.loads(preflight.stdout)
            output = root / "release-receipt.json"
            self._receipt(tarball, provenance, dependencies, output)

            receipt = json.loads(output.read_text(encoding="utf-8"))
            manifest = json.loads((stage / "package.json").read_text(encoding="utf-8"))

            self.assertEqual(receipt["schema_version"], 1)
            self.assertEqual(
                receipt["package"],
                {
                    "name": manifest["name"],
                    "version": manifest["version"],
                    "private": True,
                    "type": "module",
                },
            )
            self.assertEqual(receipt["artifact"]["filename"], tarball.name)
            self.assertEqual(receipt["artifact"]["size"], tarball.stat().st_size)
            self.assertEqual(
                receipt["artifact"]["sha256"],
                hashlib.sha256(tarball.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                receipt["evidence"]["provenance_sha256"],
                hashlib.sha256(provenance.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                receipt["evidence"]["dependency_evidence_sha256"],
                hashlib.sha256(dependencies.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                receipt["evidence"]["preflight_contract_sha256"],
                hashlib.sha256(PREFLIGHT.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                receipt["evidence"]["preflight_result_sha256"],
                hashlib.sha256(preflight.stdout.encode("utf-8")).hexdigest(),
            )
            self.assertEqual(preflight_result["artifact_sha256"], receipt["artifact"]["sha256"])
            self.assertEqual(preflight_result["package"]["name"], receipt["package"]["name"])
            self.assertEqual(preflight_result["package"]["version"], receipt["package"]["version"])
            self.assertIs(preflight_result["accepted"], True)
            self.assertIs(preflight_result["runtime_evidence_bound"], True)
            self.assertIs(preflight_result["network_access"], False)
            self.assertIs(preflight_result["external_mutation"], False)
            self.assertIs(receipt["verification"]["preflight_passed"], True)
            self.assertIs(receipt["verification"]["runtime_evidence_bound"], True)
            self.assertIs(receipt["verification"]["network_access"], False)
            self.assertIs(receipt["verification"]["external_mutation"], False)
            self.assertEqual(receipt["authority"], "unchanged")
            self.assertIs(receipt["network_access"], False)
            self.assertIs(receipt["external_mutation"], False)

            tampered = json.loads(provenance.read_text(encoding="utf-8"))
            tampered["artifact"]["sha256"] = "0" * 64
            tampered_path = root / "tampered-provenance.json"
            tampered_path.write_text(
                json.dumps(tampered, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            rejected_output = root / "must-not-exist.json"
            rejected = self._receipt(
                tarball,
                tampered_path,
                dependencies,
                rejected_output,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(rejected_output.exists())

    def test_receipt_is_deterministic_bounded_secret_free_and_registry_free(self) -> None:
        source = RECEIPT.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm publish",
            "npm login",
            "npm view",
            "registry.npmjs.org",
            "curl ",
            "wget ",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, tarball, provenance, dependencies = self._build_evidence(root)
            first = root / "receipt-a.json"
            second = root / "receipt-b.json"
            self._receipt(tarball, provenance, dependencies, first)
            self._receipt(tarball, provenance, dependencies, second)

            first_body = first.read_text(encoding="utf-8")
            second_body = second.read_text(encoding="utf-8")
            payload = json.loads(first_body)
            self.assertEqual(first_body, second_body)
            self.assertEqual(
                first_body,
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
            )
            self.assertLessEqual(len(first.read_bytes()), 4096)

            lowered = first_body.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn("http://", lowered)
            self.assertNotIn("https://", lowered)
            self.assertNotIn("registry", lowered)
            self.assertNotIn("timestamp", lowered)
            self.assertNotIn("created_at", lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("release-receipt-secret-user-8d2f9a", lowered)

            unknown = json.loads(provenance.read_text(encoding="utf-8"))
            unknown["unexpected"] = True
            unknown_path = root / "unknown-provenance.json"
            unknown_path.write_text(
                json.dumps(unknown, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            unknown_output = root / "unknown-output.json"
            failed_unknown = self._receipt(
                tarball,
                unknown_path,
                dependencies,
                unknown_output,
                check=False,
            )
            self.assertNotEqual(failed_unknown.returncode, 0)
            self.assertFalse(unknown_output.exists())

            original = json.loads(provenance.read_text(encoding="utf-8"))
            reordered = dict(reversed(list(original.items())))
            reordered_path = root / "reordered-provenance.json"
            reordered_path.write_text(
                json.dumps(reordered, indent=2) + "\n",
                encoding="utf-8",
            )
            reordered_output = root / "reordered-output.json"
            failed_reordered = self._receipt(
                tarball,
                reordered_path,
                dependencies,
                reordered_output,
                check=False,
            )
            self.assertNotEqual(failed_reordered.returncode, 0)
            self.assertFalse(reordered_output.exists())

            copied_preflight = root / PREFLIGHT.name
            copied_preflight.write_bytes(PREFLIGHT.read_bytes())
            wrong_output = root / "wrong-preflight.json"
            failed_preflight = self._receipt(
                tarball,
                provenance,
                dependencies,
                wrong_output,
                preflight=copied_preflight,
                check=False,
            )
            self.assertNotEqual(failed_preflight.returncode, 0)
            self.assertFalse(wrong_output.exists())


if __name__ == "__main__":
    unittest.main()
