import copy
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
CONSUMER = ROOT / "scripts" / "check-controlbot-http-package-consumer.ts"
PUBLIC_SUBPATH = "@pl0n3r/factoryrunner/controlbot-http"
REQUIREMENTS = {
    "version": 1,
    "subpath": "./controlbot-http",
    "protocol_version": 1,
    "fencing": "required",
    "session_transport": "injected_test_only",
    "authority": "unchanged",
    "execution": False,
    "network_access": False,
    "external_mutation": False,
    "required_exports": [
        {"export_name": "controlBotRunnerHttpRequest", "contract_version": 1, "capability": "protocol"},
        {"export_name": "assertFencedAck", "contract_version": 1, "capability": "fencing"},
        {"export_name": "assertFencedEvent", "contract_version": 1, "capability": "fencing"},
        {"export_name": "bindFencedExecution", "contract_version": 1, "capability": "fencing"},
        {"export_name": "ControlBotHttpSessionClient", "contract_version": 1, "capability": "session"},
        {"export_name": "HttpSessionClientError", "contract_version": 1, "capability": "session"},
    ],
}


class FactoryRunnerControlBotHttpPackageConsumerTests(unittest.TestCase):
    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        helper = VerifiedReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        return helper._bundle(root)

    def _requirements(
        self,
        root: Path,
        payload: dict[str, object] | None = None,
        filename: str = "controlbot-http-requirements.json",
    ) -> Path:
        path = root / filename
        path.write_text(
            json.dumps(REQUIREMENTS if payload is None else payload, indent=2, sort_keys=True) + "\n",
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
                f"controlbot http consumer failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def test_consumer_imports_only_controlbot_http_public_subpath_after_compatibility_check(self):
        source = CONSUMER.read_text(encoding="utf-8")
        lowered = source.lower()
        self.assertLess(
            lowered.index("const verification = verifyreceipt(options, version)"),
            lowered.index("const compatibility = await verifycompatibility(options)"),
        )
        self.assertLess(
            lowered.index("const compatibility = await verifycompatibility(options)"),
            lowered.index("const consumed = await consumeartifact(options)"),
        )
        self.assertIn(
            "} from '@pl0n3r/factoryrunner/controlbot-http';",
            source,
        )
        self.assertNotIn("@pl0n3r/factoryrunner/src/", source)
        self.assertEqual(
            source.count("@pl0n3r/factoryrunner/controlbot-http"),
            2,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            requirements = self._requirements(root)
            result = json.loads(
                self._run(receipt, artifact, provenance, dependencies, requirements).stdout
            )

        self.assertIs(result["verified"], True)
        self.assertIs(result["installed_from_local_artifact"], True)
        self.assertIs(result["public_api_consumed"], True)
        self.assertEqual(result["public_import"], PUBLIC_SUBPATH)
        self.assertEqual(result["compatibility_status"], "COMPATIBLE")
        self.assertEqual(result["compatibility_reasons"], [])
        self.assertEqual(result["protocol_path"], "/v1/runner/poll")
        self.assertEqual(result["binding_authority"], "unchanged")
        self.assertEqual(result["ack_kind"], "ack")

    def test_consumer_runs_offline_with_ignore_scripts_and_fake_transport_only(self):
        source = CONSUMER.read_text(encoding="utf-8")
        lowered = source.lower()
        for required in (
            "npm_config_offline: 'true'",
            "npm_config_ignore_scripts: 'true'",
            "'--offline'",
            "'--ignore-scripts'",
            "test_mode: true",
            "test_transport: async",
        ):
            self.assertIn(required, source)

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
                self._run(receipt, artifact, provenance, dependencies, requirements).stdout
            )

        self.assertEqual(result["transport_mode"], "injected_test_only")
        self.assertEqual(result["response_status"], 200)
        self.assertIs(result["scripts_disabled"], True)
        self.assertIs(result["registry_access"], False)
        self.assertIs(result["publish_attempted"], False)
        self.assertIs(result["network_access"], False)

    def test_stale_incompatible_tampered_or_missing_public_contract_fails_before_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            temp_root = root / "consumer-tmp"
            temp_root.mkdir()
            env = os.environ.copy()
            env["TMPDIR"] = str(temp_root)

            cases: list[tuple[str, dict[str, object]]] = []

            stale = copy.deepcopy(REQUIREMENTS)
            stale["version"] = 2
            cases.append(("stale", stale))

            incompatible = copy.deepcopy(REQUIREMENTS)
            incompatible["protocol_version"] = 2
            cases.append(("incompatible", incompatible))

            tampered = copy.deepcopy(REQUIREMENTS)
            tampered["required_exports"][0]["contract_version"] = 2
            cases.append(("tampered", tampered))

            missing = copy.deepcopy(REQUIREMENTS)
            missing["required_exports"] = missing["required_exports"][:-1]
            cases.append(("missing", missing))

            unknown = copy.deepcopy(REQUIREMENTS)
            unknown["required_exports"].append(
                {"export_name": "unknownRuntimeExport", "contract_version": 1, "capability": "protocol"}
            )
            cases.append(("unknown", unknown))

            for name, payload in cases:
                with self.subTest(name=name):
                    requirements = self._requirements(root, payload, f"{name}.json")
                    rejected = self._run(
                        receipt,
                        artifact,
                        provenance,
                        dependencies,
                        requirements,
                        check=False,
                        env=env,
                    )
                    self.assertNotEqual(rejected.returncode, 0)
                    self.assertEqual(list(temp_root.iterdir()), [])

    def test_output_is_bounded_secret_free_and_non_executing(self):
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

        self.assertLess(len(completed.stdout.encode("utf-8")), 4096)
        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["execution"], False)
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)
        self.assertEqual(
            result["receipt_sha256"],
            hashlib.sha256(receipt.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            result["artifact_sha256"],
            hashlib.sha256(artifact.read_bytes()).hexdigest(),
        )

        serialized = json.dumps(result, sort_keys=True).lower()
        for forbidden in (
            "password",
            "cookie",
            "authorization",
            "bearer ",
            "dsn",
            "instruction_ref",
            "controlbot:instruction",
            "token",
            "secret",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
