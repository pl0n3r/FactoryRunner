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
CONSUMER = ROOT / "scripts" / "check-execution-admission-package-consumer.ts"
PUBLIC_SUBPATH = "@pl0n3r/factoryrunner/execution-admission"
REQUIREMENTS = (
    {"export_name": "AdmissionEvidence", "contract_version": 1},
    {"export_name": "ExecutionAdmissionDecision", "contract_version": 1},
    {"export_name": "ExecutionAdmissionState", "contract_version": 1},
    {"export_name": "admissionEvidence", "contract_version": 1},
    {"export_name": "executionAdmissionDecision", "contract_version": 1},
)


class FactoryRunnerExecutionAdmissionPackageConsumerTests(unittest.TestCase):
    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        helper = VerifiedReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        return helper._bundle(root)

    def _requirements(
        self,
        root: Path,
        requirements: tuple[dict[str, object], ...] = REQUIREMENTS,
        filename: str = "execution-admission-requirements.json",
    ) -> Path:
        path = root / filename
        path.write_text(
            json.dumps(list(requirements), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return path

    def _run(
        self,
        receipt: Path,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
        requirements: Path,
        *,
        preflight: Path = PREFLIGHT,
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
                str(preflight),
                "--requirements",
                str(requirements),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"execution admission consumer failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def test_verified_local_artifact_is_required_before_execution_admission_import(self) -> None:
        source = CONSUMER.read_text(encoding="utf-8")
        lowered = source.lower()
        self.assertLess(
            lowered.index("const verification = verifyreceipt(options, expectedversion)"),
            lowered.index("const compatibility = await verifycompatibility(options)"),
        )
        self.assertLess(
            lowered.index("const compatibility = await verifycompatibility(options)"),
            lowered.index("const consumed = await consumeverifiedartifact(options, fixture)"),
        )
        self.assertIn(
            "from '@pl0n3r/factoryrunner/execution-admission';",
            source,
        )
        self.assertNotIn("@pl0n3r/factoryrunner/src/", source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            requirements = self._requirements(root)
            completed = self._run(
                receipt,
                artifact,
                provenance,
                dependencies,
                requirements,
            )
            result = json.loads(completed.stdout)
            self.assertIs(result["verified"], True)
            self.assertIs(result["installed_from_local_artifact"], True)
            self.assertIs(result["public_api_consumed"], True)
            self.assertEqual(result["public_import"], PUBLIC_SUBPATH)
            self.assertEqual(
                result["receipt_sha256"],
                hashlib.sha256(receipt.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                result["artifact_sha256"],
                hashlib.sha256(artifact.read_bytes()).hexdigest(),
            )

    def test_verified_subpath_consumes_allow_and_admission_evidence_with_unchanged_authority(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            requirements = self._requirements(root)
            result = json.loads(
                self._run(
                    receipt,
                    artifact,
                    provenance,
                    dependencies,
                    requirements,
                ).stdout
            )

        self.assertEqual(result["compatibility_status"], "COMPATIBLE")
        self.assertEqual(result["compatibility_authority"], "unchanged")
        self.assertEqual(result["compatibility_reasons"], [])
        self.assertEqual(result["decision"], "ALLOW")
        self.assertEqual(result["decision_authority"], "unchanged")
        self.assertEqual(result["evidence_decision"], "ALLOW")
        self.assertEqual(result["evidence_authority"], "unchanged")
        self.assertEqual(
            result["evidence_decision_fingerprint"],
            result["decision_fingerprint"],
        )
        self.assertRegex(result["decision_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(result["evidence_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["execution"], False)
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)

        serialized = json.dumps(result, sort_keys=True).lower()
        for forbidden in (
            "instruction_ref",
            "controlbot:instruction",
            "payload",
            "adapters",
            "capabilities",
            "secret",
            "token",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

    def test_mixed_stale_tampered_or_incompatible_evidence_fails_before_consumer(self) -> None:
        source = CONSUMER.read_text(encoding="utf-8")
        self.assertIn("packageValue.name !== EXPECTED_PACKAGE", source)
        self.assertIn("packageValue.version !== expectedVersion", source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            requirements = self._requirements(root)

            temp_root = root / "consumer-tmp"
            temp_root.mkdir()
            env = os.environ.copy()
            env["TMPDIR"] = str(temp_root)

            substituted = root / "mixed-artifact.tgz"
            substituted.write_bytes(artifact.read_bytes() + b"tamper")

            mixed_payload = json.loads(dependencies.read_text(encoding="utf-8"))
            mixed_payload["package"]["version"] = "9.9.9"
            mixed_dependencies = root / "mixed-dependencies.json"
            mixed_dependencies.write_text(
                json.dumps(mixed_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

            copied_preflight = root / PREFLIGHT.name
            copied_preflight.write_bytes(PREFLIGHT.read_bytes())

            payload = json.loads(receipt.read_text(encoding="utf-8"))
            payload["artifact"]["sha256"] = "0" * 64
            tampered = root / "tampered-receipt.json"
            tampered.write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

            incompatible = self._requirements(
                root,
                tuple(
                    {**item, "contract_version": 2}
                    if item["export_name"] == "executionAdmissionDecision"
                    else dict(item)
                    for item in REQUIREMENTS
                ),
                "incompatible-requirements.json",
            )

            cases: list[
                tuple[str, Path, Path, Path, Path, Path, Path]
            ] = [
                (
                    "mixed_artifact",
                    receipt,
                    substituted,
                    provenance,
                    dependencies,
                    requirements,
                    PREFLIGHT,
                ),
                (
                    "mixed_dependencies",
                    receipt,
                    artifact,
                    provenance,
                    mixed_dependencies,
                    requirements,
                    PREFLIGHT,
                ),
                (
                    "stale_preflight",
                    receipt,
                    artifact,
                    provenance,
                    dependencies,
                    requirements,
                    copied_preflight,
                ),
                (
                    "tampered_receipt",
                    tampered,
                    artifact,
                    provenance,
                    dependencies,
                    requirements,
                    PREFLIGHT,
                ),
                (
                    "incompatible_contract",
                    receipt,
                    artifact,
                    provenance,
                    dependencies,
                    incompatible,
                    PREFLIGHT,
                ),
            ]

            for (
                name,
                receipt_path,
                artifact_path,
                provenance_path,
                dependencies_path,
                requirement_file,
                preflight_path,
            ) in cases:
                with self.subTest(name=name):
                    rejected = self._run(
                        receipt_path,
                        artifact_path,
                        provenance_path,
                        dependencies_path,
                        requirement_file,
                        preflight=preflight_path,
                        check=False,
                        env=env,
                    )
                    self.assertNotEqual(rejected.returncode, 0)
                    self.assertEqual(list(temp_root.iterdir()), [])

    def test_consumer_is_local_scripts_disabled_and_has_no_network_publish_or_external_mutation(self) -> None:
        source = CONSUMER.read_text(encoding="utf-8")
        lowered = source.lower()
        self.assertIn("npm_config_offline: 'true'", source)
        self.assertIn("npm_config_ignore_scripts: 'true'", source)
        self.assertIn("'--offline'", source)
        self.assertIn("'--ignore-scripts'", source)

        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm publish",
            "npm login",
            "npm adduser",
            "npm view",
            "--registry",
            "registry.npmjs.org",
            "curl ",
            "wget ",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, lowered)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            requirements = self._requirements(root)
            result = json.loads(
                self._run(
                    receipt,
                    artifact,
                    provenance,
                    dependencies,
                    requirements,
                ).stdout
            )

        self.assertIs(result["scripts_disabled"], True)
        self.assertIs(result["registry_access"], False)
        self.assertIs(result["publish_attempted"], False)
        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["execution"], False)
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)


if __name__ == "__main__":
    unittest.main()
