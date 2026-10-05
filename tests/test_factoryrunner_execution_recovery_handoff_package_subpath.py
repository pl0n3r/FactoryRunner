import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
ROOT_ENTRYPOINT = "src/browser-remote-observability-public.ts"
RECOVERY_ENTRYPOINT = "src/execution-recovery-handoff-public.ts"
EXPECTED_EXPORTS = {
    ".": f"./{ROOT_ENTRYPOINT}",
    "./controlbot-http": "./src/controlbot-http-public.ts",
    "./execution-admission": "./src/execution-admission-public.ts",
    "./recovery-handoff": f"./{RECOVERY_ENTRYPOINT}",
}
EXPECTED_STAGED_EXPORTS = {
    ".": "./src/browser-remote-observability-public.js",
    "./controlbot-http": "./src/controlbot-http-public.js",
    "./execution-admission": "./src/execution-admission-public.js",
    "./recovery-handoff": "./src/execution-recovery-handoff-public.js",
}
EXPORT_RE = re.compile(
    r"""export\s+(?:type\s+)?\{(?P<body>[^}]*)\}\s+from\s+["'][^"']+["'];?""",
    re.DOTALL,
)
EXPECTED_RECOVERY_SYMBOLS = {
    "executionRecoveryHandoffPacket",
    "ExecutionRecoveryHandoffPacket",
    "executionRecoveryHandoffVerify",
    "ExecutionRecoveryHandoffVerification",
    "executionRecoveryHandoffPreview",
    "ExecutionRecoveryHandoffPreview",
    "executionRecoveryHandoffManifest",
    "ExecutionRecoveryHandoffManifest",
    "executionRecoveryHandoffManifestVerify",
    "ExecutionRecoveryHandoffManifestVerification",
    "executionRecoveryHandoffManifestPreview",
    "ExecutionRecoveryHandoffManifestPreview",
    "executionRecoveryHandoffPublicManifest",
    "ExecutionRecoveryHandoffPublicExportName",
    "ExecutionRecoveryHandoffPublicManifest",
    "ExecutionRecoveryHandoffPublicManifestEntry",
    "executionRecoveryHandoffPublicCompatibility",
    "ExecutionRecoveryHandoffPublicCompatibility",
    "ExecutionRecoveryHandoffPublicCompatibilityReason",
    "ExecutionRecoveryHandoffPublicRequirement",
}


class FactoryRunnerExecutionRecoveryHandoffPackageSubpathTests(unittest.TestCase):
    def manifest(self) -> dict:
        return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    def recovery_symbols(self) -> set[str]:
        source = (ROOT / RECOVERY_ENTRYPOINT).read_text(encoding="utf-8")
        self.assertNotIn("export *", source)
        symbols: set[str] = set()
        for match in EXPORT_RE.finditer(source):
            for raw in match.group("body").split(","):
                item = raw.strip()
                if not item:
                    continue
                if item.startswith("type "):
                    item = item[5:].strip()
                symbols.add(item.split(" as ", 1)[-1].strip())
        return symbols

    def test_recovery_handoff_subpath_is_additive_and_root_is_unchanged(self):
        manifest = self.manifest()
        self.assertEqual(manifest.get("exports"), EXPECTED_EXPORTS)
        self.assertEqual(
            manifest["exports"]["."],
            "./src/browser-remote-observability-public.ts",
        )
        self.assertEqual(
            manifest["exports"]["./recovery-handoff"],
            "./src/execution-recovery-handoff-public.ts",
        )

    def test_subpath_exports_only_supported_public_recovery_contracts(self):
        self.assertEqual(self.recovery_symbols(), EXPECTED_RECOVERY_SYMBOLS)
        source = (ROOT / RECOVERY_ENTRYPOINT).read_text(encoding="utf-8")
        for forbidden in (
            "validation.ts",
            "Driver",
            "Adapter",
            "runtime-supervisor",
            "controlbot",
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)

    def test_builder_and_allowlist_stage_both_public_entrypoints_without_new_authority(self):
        source_manifest = self.manifest()
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp) / "stage"
            completed = subprocess.run(
                [
                    "node",
                    "--experimental-strip-types",
                    str(BUILDER),
                    "--output",
                    str(stage),
                ],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            staged = json.loads(
                (stage / "package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(staged.get("exports"), EXPECTED_STAGED_EXPORTS)
            self.assertNotIn("dependencies", staged)
            self.assertNotIn("scripts", staged)
            self.assertNotIn("publishConfig", staged)
            self.assertNotIn("bin", staged)

            expected_files = [
                path.removesuffix(".ts") + ".js"
                for path in source_manifest["files"]
            ]
            self.assertEqual(staged.get("files"), expected_files)
            for relative in expected_files:
                self.assertTrue((stage / relative).is_file(), relative)

            recovery_script = Path(tmp) / "verify-recovery.mjs"
            recovery_script.write_text(
                f"""import {{
  executionRecoveryHandoffPublicCompatibility,
  executionRecoveryHandoffPublicManifest,
}} from {json.dumps((stage / "src/execution-recovery-handoff-public.js").as_uri())};

const manifest = executionRecoveryHandoffPublicManifest();
const compatibility = executionRecoveryHandoffPublicCompatibility(
  manifest,
  [manifest.exports[0]],
);
process.stdout.write(JSON.stringify({{
  manifest_authority: manifest.authority,
  manifest_execution: manifest.execution,
  manifest_network_access: manifest.network_access,
  manifest_external_mutation: manifest.external_mutation,
  compatibility_status: compatibility.status,
  compatibility_authority: compatibility.authority,
  compatibility_execution: compatibility.execution,
  compatibility_network_access: compatibility.network_access,
  compatibility_external_mutation: compatibility.external_mutation,
}}));
""",
                encoding="utf-8",
            )
            verify = subprocess.run(
                ["node", str(recovery_script)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(verify.returncode, 0, verify.stderr)
            observed = json.loads(verify.stdout)

        self.assertEqual(observed["manifest_authority"], "unchanged")
        self.assertIs(observed["manifest_execution"], False)
        self.assertIs(observed["manifest_network_access"], False)
        self.assertIs(observed["manifest_external_mutation"], False)
        self.assertEqual(observed["compatibility_status"], "COMPATIBLE")
        self.assertEqual(observed["compatibility_authority"], "unchanged")
        self.assertIs(observed["compatibility_execution"], False)
        self.assertIs(observed["compatibility_network_access"], False)
        self.assertIs(observed["compatibility_external_mutation"], False)


if __name__ == "__main__":
    unittest.main()
