import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_factoryrunner_observability_package_release_receipt import (
    FactoryRunnerObservabilityPackageReleaseReceiptTests as ReceiptFixture,
)


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
CONSUMER = ROOT / "scripts" / "check-observability-package-verified-consumer.ts"


class FactoryRunnerObservabilityPackageVerifiedConsumerTests(unittest.TestCase):
    def _fixture(self) -> ReceiptFixture:
        return ReceiptFixture(
            "test_receipt_binds_exact_artifact_provenance_dependencies_and_preflight_fingerprints"
        )

    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        helper = self._fixture()
        _, artifact, provenance, dependencies = helper._build_evidence(root)
        receipt = root / "receipt.json"
        helper._receipt(artifact, provenance, dependencies, receipt)
        return artifact, provenance, dependencies, receipt

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
                result["receipt_sha256"],
                hashlib.sha256(receipt.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(artifact.read_bytes()).hexdigest(),
            )
            self.assertEqual(result["packet_status"], "READY")
            self.assertEqual(result["packet_authority"], "unchanged")
            self.assertEqual(result["authority"], "unchanged")
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)

    def test_missing_or_mismatched_receipt_blocks_install_without_registry_access(self) -> None:
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
            mismatched = root / "mismatched-receipt.json"
            mismatched.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            rejected_mismatch = self._run(
                mismatched,
                artifact,
                provenance,
                dependencies,
                check=False,
                env=env,
            )
            self.assertNotEqual(rejected_mismatch.returncode, 0)
            self.assertFalse(marker.exists())
            self.assertEqual(list(temp_root.iterdir()), [])
            self.assertNotIn("registry", rejected_mismatch.stderr.lower())


if __name__ == "__main__":
    unittest.main()
