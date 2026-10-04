import copy
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_factoryrunner_observability_package_release_receipt import (
    FactoryRunnerObservabilityPackageReleaseReceiptTests as ReceiptFixture,
)


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
VERIFIER = ROOT / "scripts" / "check-observability-package-release-receipt.ts"


class FactoryRunnerObservabilityPackageReleaseReceiptVerifyTests(unittest.TestCase):
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
        return subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(VERIFIER),
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
            ],
            cwd=ROOT,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def _write(self, path: Path, payload: object) -> None:
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)

            first = self._verify(receipt, artifact, provenance, dependencies)
            second = self._verify(receipt, artifact, provenance, dependencies)
            self.assertEqual(first.stdout, second.stdout)

            result = json.loads(first.stdout)
            receipt_payload = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertIs(result["verified"], True)
            self.assertEqual(
                result["receipt_sha256"],
                hashlib.sha256(receipt.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(artifact.read_bytes()).hexdigest(),
            )
            self.assertEqual(result["package"], receipt_payload["package"])
            self.assertEqual(result["authority"], "unchanged")
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)

            linked = root / "receipt-link.json"
            linked.symlink_to(receipt)
            rejected = self._verify(
                linked,
                artifact,
                provenance,
                dependencies,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)

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

            receipt_cases: list[tuple[str, dict]] = []
            tampered = copy.deepcopy(original)
            tampered["artifact"]["sha256"] = "0" * 64
            receipt_cases.append(("tampered", tampered))

            unknown = copy.deepcopy(original)
            unknown["unexpected"] = True
            receipt_cases.append(("unknown", unknown))

            schema = copy.deepcopy(original)
            schema["schema_version"] = 2
            receipt_cases.append(("schema", schema))

            authority = copy.deepcopy(original)
            authority["authority"] = "publish"
            receipt_cases.append(("authority", authority))

            for label, payload in receipt_cases:
                with self.subTest(label=label):
                    candidate = root / f"{label}.json"
                    self._write(candidate, payload)
                    rejected = self._verify(
                        candidate,
                        artifact,
                        provenance,
                        dependencies,
                        check=False,
                    )
                    self.assertNotEqual(rejected.returncode, 0)

            mixed = json.loads(dependencies.read_text(encoding="utf-8"))
            mixed["package"]["version"] = "9.9.9"
            mixed_path = root / "mixed-dependencies.json"
            self._write(mixed_path, mixed)
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

            substituted = root / "substituted.tgz"
            substituted.write_bytes(artifact.read_bytes() + b"tamper")
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
