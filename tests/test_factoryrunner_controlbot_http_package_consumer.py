import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import test_factoryrunner_observability_package_release_receipt as receipt_builder_module
from test_factoryrunner_observability_package_release_receipt_verify import (
    FactoryRunnerObservabilityPackageReleaseReceiptVerifyTests as ReceiptFixture,
)


ROOT = Path(__file__).resolve().parents[1]
CONSUMER = ROOT / "scripts" / "check-controlbot-http-package-consumer.ts"
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
PUBLIC_SUBPATH = "@pl0n3r/factoryrunner/controlbot-http"
BASE_REQUIREMENTS = {
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
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        fixture = ReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        cls.artifact, cls.provenance, cls.dependencies, cls.receipt = fixture._bundle(cls.root)
        cls.requirements = cls._write_requirements(BASE_REQUIREMENTS, "requirements.json")
        cls.completed = cls._invoke(cls.requirements)
        cls.result = json.loads(cls.completed.stdout)
        cls.source = CONSUMER.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def _write_requirements(cls, payload, filename):
        path = cls.root / filename
        path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        return path

    @classmethod
    def _invoke(
        cls,
        requirements,
        *,
        check=True,
        env=None,
        receipt=None,
        artifact=None,
        provenance=None,
        dependencies=None,
    ):
        completed = subprocess.run(
            [
                "node", "--experimental-strip-types", str(CONSUMER),
                "--receipt", str(receipt or cls.receipt),
                "--artifact", str(artifact or cls.artifact),
                "--provenance", str(provenance or cls.provenance),
                "--dependencies", str(dependencies or cls.dependencies),
                "--preflight", str(PREFLIGHT),
                "--requirements", str(requirements),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if check and completed.returncode != 0:
            raise AssertionError(
                f"consumer exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    @classmethod
    def _coherent_incompatible_bundle(cls):
        root = cls.root / "incompatible-installed-surface"
        root.mkdir(exist_ok=True)
        fixture = ReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        builder = fixture._fixture()
        stage, _, _, _ = builder._build_evidence(root)

        manifest = stage / "src" / "controlbot-http-public-manifest.js"
        source = manifest.read_text(encoding="utf-8")
        lines = source.splitlines(keepends=True)
        filtered = [
            line for line in lines
            if "export_name: 'HttpSessionClientError'" not in line
        ]
        if len(lines) - len(filtered) != 1:
            raise AssertionError("No fue posible recortar exactamente un export del manifest staged")
        manifest.write_text("".join(filtered), encoding="utf-8")

        pack = root / "repacked"
        pack.mkdir()
        packed = subprocess.run(
            [
                "npm", "pack", "--json", "--offline", "--ignore-scripts",
                "--pack-destination", str(pack), ".",
            ],
            cwd=stage,
            env=builder._npm_env(root / "repack-cache"),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        pack_result = json.loads(packed.stdout)
        if len(pack_result) != 1:
            raise AssertionError("npm pack produjo una cantidad inesperada de artefactos")
        artifact = pack / pack_result[0]["filename"]

        provenance = root / "repacked-provenance.json"
        builder._run_node(
            receipt_builder_module.PROVENANCE,
            "--tarball", str(artifact),
            "--stage", str(stage),
            "--output", str(provenance),
        )
        dependencies = root / "repacked-dependencies.json"
        builder._run_node(
            receipt_builder_module.DEPENDENCIES,
            "--manifest", str(stage / "package.json"),
            "--lockfile", str(receipt_builder_module.LOCKFILE),
            "--output", str(dependencies),
        )
        receipt = root / "repacked-receipt.json"
        builder._receipt(artifact, provenance, dependencies, receipt)
        return artifact, provenance, dependencies, receipt

    def test_consumer_imports_only_controlbot_http_public_subpath_after_compatibility_check(self):
        lowered = self.source.lower()
        self.assertLess(
            lowered.index("const receipt = verifiedreceipt(value)"),
            lowered.index("const compatibilitybinding = await compatiblerequirements(value.requirements)"),
        )
        self.assertLess(
            lowered.index("const compatibilitybinding = await compatiblerequirements(value.requirements)"),
            lowered.index("const consumed = await consume(value.artifact, compatibilitybinding)"),
        )
        self.assertIn("from '@pl0n3r/factoryrunner/controlbot-http';", self.source)
        self.assertNotIn("@pl0n3r/factoryrunner/src/", self.source)
        self.assertEqual(self.result["public_import"], PUBLIC_SUBPATH)
        self.assertEqual(self.result["compatibility_status"], "COMPATIBLE")
        self.assertEqual(self.result["protocol_path"], "/v1/runner/poll")
        self.assertEqual(self.result["binding_authority"], "unchanged")

    def test_installed_manifest_is_checked_against_external_requirements(self):
        self.assertIn(
            "controlBotHttpPublicCompatibility(manifest, externalRequirement)",
            self.source,
        )
        self.assertIn("const externalRequirement = ${binding.requirements_json};", self.source)
        self.assertNotIn("required_exports: manifest.exports.map", self.source)
        self.assertEqual(
            self.result["manifest_fingerprint"],
            self.result["installed_manifest_fingerprint"],
        )

    def test_installed_manifest_fingerprint_must_match_prechecked_surface(self):
        self.assertIn(
            "compatibility.manifest_fingerprint !== expectedManifestFingerprint",
            self.source,
        )
        self.assertIn("manifest.fingerprint !== expectedManifestFingerprint", self.source)
        self.assertEqual(
            self.result["compatibility_fingerprint"],
            self.result["installed_compatibility_fingerprint"],
        )
        for key in (
            "manifest_fingerprint",
            "installed_manifest_fingerprint",
            "compatibility_fingerprint",
            "installed_compatibility_fingerprint",
        ):
            self.assertRegex(self.result[key], r"^[a-f0-9]{64}$")

    def test_receipt_valid_but_incompatible_installed_surface_fails_before_use(self):
        artifact, provenance, dependencies, receipt = self._coherent_incompatible_bundle()
        rejected = self._invoke(
            self.requirements,
            check=False,
            artifact=artifact,
            provenance=provenance,
            dependencies=dependencies,
            receipt=receipt,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Consumer ControlBot HTTP rechazado.", rejected.stderr)
        self.assertNotIn("Release receipt rechazado.", rejected.stderr)

    def test_consumer_runs_offline_with_ignore_scripts_and_fake_transport_only(self):
        for marker in (
            "npm_config_offline: 'true'",
            "npm_config_ignore_scripts: 'true'",
            "'--offline'",
            "'--ignore-scripts'",
            "test_mode: true",
            "test_transport: async",
        ):
            self.assertIn(marker, self.source)

        lowered = self.source.lower()
        for forbidden in (
            "node:http", "node:https", "fetch(", "npm publish", "npm login",
            "npm adduser", "npm view", "--registry", "registry.npmjs.org",
            "curl ", "wget ",
        ):
            self.assertNotIn(forbidden, lowered)

        self.assertEqual(self.result["transport_mode"], "injected_test_only")
        self.assertEqual(self.result["response_status"], 200)
        self.assertIs(self.result["scripts_disabled"], True)
        self.assertIs(self.result["registry_access"], False)
        self.assertIs(self.result["network_access"], False)

    def test_stale_incompatible_tampered_or_missing_public_contract_fails_before_use(self):
        scenarios = {}

        stale = copy.deepcopy(BASE_REQUIREMENTS)
        stale["version"] = 2
        scenarios["stale"] = stale

        protocol = copy.deepcopy(BASE_REQUIREMENTS)
        protocol["protocol_version"] = 2
        scenarios["incompatible"] = protocol

        tampered = copy.deepcopy(BASE_REQUIREMENTS)
        tampered["required_exports"][0]["contract_version"] = 2
        scenarios["tampered"] = tampered

        missing = copy.deepcopy(BASE_REQUIREMENTS)
        missing["required_exports"] = missing["required_exports"][:-1]
        scenarios["missing"] = missing

        temp_root = self.root / "rejected-consumers"
        temp_root.mkdir(exist_ok=True)
        env = os.environ.copy()
        env["TMPDIR"] = str(temp_root)

        for case_id, payload in scenarios.items():
            with self.subTest(case_id=case_id):
                requirement_path = self._write_requirements(payload, case_id + ".json")
                rejected = self._invoke(requirement_path, check=False, env=env)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(list(temp_root.iterdir()), [])

    def test_output_is_bounded_secret_free_and_non_executing(self):
        self.assertLess(len(self.completed.stdout.encode("utf-8")), 4096)
        self.assertEqual(self.result["authority"], "unchanged")
        self.assertIs(self.result["execution"], False)
        self.assertIs(self.result["network_access"], False)
        self.assertIs(self.result["external_mutation"], False)
        self.assertEqual(
            self.result["receipt_sha256"],
            hashlib.sha256(self.receipt.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            self.result["artifact_sha256"],
            hashlib.sha256(self.artifact.read_bytes()).hexdigest(),
        )

        serialized = json.dumps(self.result, sort_keys=True).lower()
        for forbidden in (
            "password", "cookie", "authorization", "bearer ", "dsn",
            "instruction_ref", "controlbot:instruction", "token", "secret",
        ):
            self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
