import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_BUILDER = ROOT / "scripts" / "build-observability-package.ts"
PROVENANCE = ROOT / "scripts" / "build-observability-package-provenance.ts"
DEPENDENCIES = ROOT / "scripts" / "build-observability-package-dependency-evidence.ts"
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
RECEIPT = ROOT / "scripts" / "create-observability-package-release-receipt.ts"
VERIFIER = ROOT / "scripts" / "check-observability-package-release-receipt.ts"
LOCKFILE = ROOT / "package-lock.json"


class FactoryRunnerObservabilityPackageReleaseReceiptVerifyTests(unittest.TestCase):
    def _run_node(
        self,
        script: Path,
        *arguments: str,
        check: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", str(script), *arguments],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{script.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

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

    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        stage = root / "stage"
        self._run_node(PACKAGE_BUILDER, "--output", str(stage))

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
        artifact = pack / packed[0]["filename"]

        provenance = root / "provenance.json"
        self._run_node(
            PROVENANCE,
            "--tarball",
            str(artifact),
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

        receipt = root / "receipt.json"
        self._run_node(
            RECEIPT,
            "--artifact",
            str(artifact),
            "--provenance",
            str(provenance),
            "--dependencies",
            str(dependencies),
            "--preflight",
            str(PREFLIGHT),
            "--output",
            str(receipt),
        )
        return artifact, provenance, dependencies, receipt

    def _verify(
        self,
        receipt: Path,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
        *,
        preflight: Path = PREFLIGHT,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return self._run_node(
            VERIFIER,
            "--receipt",
            str(receipt),
            "--artifact",
            str(artifact),
            "--provenance",
            str(provenance),
            "--dependencies",
            str(dependencies),
            "--preflight",
            str(preflight),
            check=check,
        )

    def test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            completed = self._verify(receipt, artifact, provenance, dependencies)
            result = json.loads(completed.stdout)

            self.assertIs(result["verified"], True)
            self.assertEqual(
                result["receipt_sha256"],
                hashlib.sha256(receipt.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(artifact.read_bytes()).hexdigest(),
            )
            self.assertEqual(result["authority"], "unchanged")
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)

            receipt_link = root / "receipt-link.json"
            receipt_link.symlink_to(receipt)
            linked = self._verify(
                receipt_link,
                artifact,
                provenance,
                dependencies,
                check=False,
            )
            self.assertNotEqual(linked.returncode, 0)

    def test_tampered_mixed_or_unknown_receipt_fails_closed_without_network(self) -> None:
        source = VERIFIER.read_text(encoding="utf-8").lower()
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
            artifact, provenance, dependencies, receipt = self._bundle(root)
            original = json.loads(receipt.read_text(encoding="utf-8"))

            tampered = json.loads(json.dumps(original))
            tampered["artifact"]["sha256"] = "0" * 64
            tampered_path = root / "tampered.json"
            tampered_path.write_text(
                json.dumps(tampered, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assertNotEqual(
                self._verify(
                    tampered_path,
                    artifact,
                    provenance,
                    dependencies,
                    check=False,
                ).returncode,
                0,
            )

            unknown = json.loads(json.dumps(original))
            unknown["unexpected"] = True
            unknown_path = root / "unknown.json"
            unknown_path.write_text(
                json.dumps(unknown, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assertNotEqual(
                self._verify(
                    unknown_path,
                    artifact,
                    provenance,
                    dependencies,
                    check=False,
                ).returncode,
                0,
            )

            reordered_path = root / "reordered.json"
            reordered_path.write_text(
                json.dumps(dict(reversed(list(original.items()))), indent=2) + "\n",
                encoding="utf-8",
            )
            self.assertNotEqual(
                self._verify(
                    reordered_path,
                    artifact,
                    provenance,
                    dependencies,
                    check=False,
                ).returncode,
                0,
            )

            alternate = root / "alternate"
            alternate.mkdir()
            substituted = alternate / artifact.name
            shutil.copyfile(artifact, substituted)
            with substituted.open("ab") as handle:
                handle.write(b"tamper")
            self.assertNotEqual(
                self._verify(
                    receipt,
                    substituted,
                    provenance,
                    dependencies,
                    check=False,
                ).returncode,
                0,
            )

            mixed = json.loads(dependencies.read_text(encoding="utf-8"))
            mixed["package"]["version"] = "9.9.9"
            mixed_path = root / "mixed-dependencies.json"
            mixed_path.write_text(
                json.dumps(mixed, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assertNotEqual(
                self._verify(
                    receipt,
                    artifact,
                    provenance,
                    mixed_path,
                    check=False,
                ).returncode,
                0,
            )

            copied_preflight = root / PREFLIGHT.name
            copied_preflight.write_bytes(PREFLIGHT.read_bytes())
            self.assertNotEqual(
                self._verify(
                    receipt,
                    artifact,
                    provenance,
                    dependencies,
                    preflight=copied_preflight,
                    check=False,
                ).returncode,
                0,
            )


if __name__ == "__main__":
    unittest.main()
