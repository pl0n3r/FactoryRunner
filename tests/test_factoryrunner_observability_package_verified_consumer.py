import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_factoryrunner_observability_package_release_receipt_verify import (
    FactoryRunnerObservabilityPackageReleaseReceiptVerifyTests as VerifiedReceiptFixture,
)


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
CONSUMER = ROOT / "scripts" / "check-observability-package-verified-consumer.ts"
ROOT_PACKAGE = "@pl0n3r/factoryrunner"
RECOVERY_SUBPATH = ROOT_PACKAGE + "/recovery-handoff"


class FactoryRunnerObservabilityPackageVerifiedConsumerTests(unittest.TestCase):
    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        helper = VerifiedReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        return helper._bundle(root)

    def _run(
        self,
        receipt: Path,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
        *,
        check: bool = True,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(CONSUMER),
                "--receipt",
                str(receipt),
                "--artifact",
                str(artifact),
                "--provenance",
                str(provenance),
                "--dependencies",
                str(dependencies),
                "--preflight",
                str(PREFLIGHT),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"verified consumer failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def test_verified_consumer_uses_recovery_handoff_subpath_after_receipt_verification(self) -> None:
        source = CONSUMER.read_text(encoding="utf-8")
        lowered = source.lower()
        self.assertLess(
            lowered.index("const verification = verifyreceipt(options)"),
            lowered.index("consumeverifiedartifact(options, verification)"),
        )
        self.assertIn(
            "from '@pl0n3r/factoryrunner/recovery-handoff';",
            source,
        )
        self.assertIn("executionRecoveryHandoffPublicManifest", source)
        self.assertIn("executionRecoveryHandoffPublicCompatibility", source)
        self.assertNotIn("@pl0n3r/factoryrunner/src/", source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            completed = self._run(receipt, artifact, provenance, dependencies)
            result = json.loads(completed.stdout)

            self.assertEqual(
                result["public_surfaces_consumed"],
                [ROOT_PACKAGE, RECOVERY_SUBPATH],
            )
            self.assertEqual(result["recovery_manifest_authority"], "unchanged")
            self.assertIs(result["recovery_manifest_execution"], False)
            self.assertIs(result["recovery_manifest_network_access"], False)
            self.assertIs(result["recovery_manifest_external_mutation"], False)
            self.assertEqual(result["recovery_compatibility_status"], "COMPATIBLE")
            self.assertEqual(result["recovery_compatibility_authority"], "unchanged")
            self.assertEqual(result["recovery_compatibility_reasons"], [])
            self.assertIs(result["recovery_compatibility_execution"], False)
            self.assertIs(result["recovery_compatibility_network_access"], False)
            self.assertIs(result["recovery_compatibility_external_mutation"], False)

    def test_temp_consumer_installs_only_artifact_with_verified_release_receipt(self) -> None:
        source = CONSUMER.read_text(encoding="utf-8").lower()
        self.assertLess(
            source.index("const verification = verifyreceipt(options)"),
            source.index("consumeverifiedartifact(options, verification)"),
        )
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
            completed = self._run(receipt, artifact, provenance, dependencies)
            result = json.loads(completed.stdout)

            self.assertIs(result["verified"], True)
            self.assertIs(result["installed_from_local_artifact"], True)
            self.assertIs(result["public_api_consumed"], True)
            self.assertEqual(
                result["public_surfaces_consumed"],
                [ROOT_PACKAGE, RECOVERY_SUBPATH],
            )
            self.assertEqual(
                result["receipt_sha256"],
                hashlib.sha256(receipt.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(artifact.read_bytes()).hexdigest(),
            )
            self.assertEqual(result["packet_status"], "READY")
            self.assertEqual(result["packet_authority"], "unchanged")
            self.assertEqual(result["recovery_compatibility_status"], "COMPATIBLE")
            self.assertEqual(result["recovery_compatibility_reasons"], [])
            self.assertEqual(result["authority"], "unchanged")
            self.assertIs(result["execution"], False)
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)

    def test_missing_or_tampered_receipt_blocks_both_public_surfaces_before_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)

            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            marker = root / "npm-invoked"
            fake_npm = fake_bin / "npm"
            fake_npm.write_text(
                "#!/bin/sh\nprintf invoked > \"$FACTORYRUNNER_NPM_MARKER\"\nexit 99\n",
                encoding="utf-8",
            )
            fake_npm.chmod(0o755)

            env = os.environ.copy()
            env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
            env["FACTORYRUNNER_NPM_MARKER"] = str(marker)
            temp_root = root / "consumer-tmp"
            temp_root.mkdir()
            env["TMPDIR"] = str(temp_root)

            missing = root / "missing-receipt.json"
            rejected_missing = self._run(
                missing,
                artifact,
                provenance,
                dependencies,
                check=False,
                env=env,
            )
            self.assertNotEqual(rejected_missing.returncode, 0)
            self.assertFalse(marker.exists())
            self.assertEqual(list(temp_root.iterdir()), [])

            payload = json.loads(receipt.read_text(encoding="utf-8"))
            payload["artifact"]["sha256"] = "0" * 64
            tampered = root / "tampered-receipt.json"
            tampered.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            rejected_tampered = self._run(
                tampered,
                artifact,
                provenance,
                dependencies,
                check=False,
                env=env,
            )
            self.assertNotEqual(rejected_tampered.returncode, 0)
            self.assertFalse(marker.exists())
            self.assertEqual(list(temp_root.iterdir()), [])
            self.assertNotIn("registry", rejected_tampered.stderr.lower())


if __name__ == "__main__":
    unittest.main()
