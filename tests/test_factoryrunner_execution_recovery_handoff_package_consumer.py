import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "check-recovery-handoff-package-consumer.ts"
PUBLIC_SUBPATH = "@pl0n3r/factoryrunner/recovery-handoff"


class FactoryRunnerExecutionRecoveryHandoffPackageConsumerTests(unittest.TestCase):
    def run_smoke(self) -> dict[str, object]:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(SMOKE),
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, dict)
        return payload

    def test_temp_consumer_installs_local_artifact_and_imports_only_recovery_handoff_subpath(self):
        result = self.run_smoke()
        self.assertIs(result["installed_from_local_artifact"], True)
        self.assertEqual(result["imported_subpath"], PUBLIC_SUBPATH)

        source = SMOKE.read_text(encoding="utf-8")
        consumer_imports = re.findall(
            r"from ['\"](@pl0n3r/factoryrunner[^'\"]*)['\"]",
            source,
        )
        self.assertEqual(consumer_imports, [PUBLIC_SUBPATH])
        self.assertNotIn("@pl0n3r/factoryrunner/src/", source)

    def test_installed_public_manifest_and_compatibility_preserve_zero_authority_and_io(self):
        result = self.run_smoke()
        self.assertEqual(result["manifest_status"], "READY")
        self.assertEqual(result["manifest_authority"], "unchanged")
        self.assertIs(result["manifest_execution"], False)
        self.assertIs(result["manifest_network_access"], False)
        self.assertIs(result["manifest_external_mutation"], False)

        self.assertEqual(result["compatibility_status"], "COMPATIBLE")
        self.assertEqual(result["compatibility_authority"], "unchanged")
        self.assertEqual(result["compatibility_reasons"], [])
        self.assertIs(result["compatibility_execution"], False)
        self.assertIs(result["compatibility_network_access"], False)
        self.assertIs(result["compatibility_external_mutation"], False)

        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)

    def test_consumer_smoke_uses_no_registry_or_publish_commands(self):
        source = SMOKE.read_text(encoding="utf-8")
        lowered = source.lower()

        self.assertIn("npm_config_offline: 'true'", source)
        self.assertIn("'--offline'", source)
        self.assertIn("'--ignore-scripts'", source)
        self.assertIs(self.run_smoke()["registry_access"], False)
        self.assertIs(self.run_smoke()["publish_attempted"], False)

        for forbidden in (
            "npm publish",
            "npm login",
            "npm adduser",
            "npm view",
            "--registry",
            "registry.npmjs.org",
            "node:http",
            "node:https",
            "fetch(",
            "curl ",
            "wget ",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
