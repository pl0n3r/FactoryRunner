import json
import posixpath
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINTS = {
    ".": "src/browser-remote-observability-public.ts",
    "./controlbot-http": "src/controlbot-http-public.ts",
    "./execution-admission": "src/execution-admission-public.ts",
    "./recovery-handoff": "src/execution-recovery-handoff-public.ts",
}
ROOT_ENTRYPOINT = ENTRYPOINTS["."]
IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']""")
EXPORT_RE = re.compile(
    r"""export\s+(?:type\s+)?\{(?P<body>[^}]*)\}\s+from\s+["'][^"']+["'];?""",
    re.DOTALL,
)
EXPECTED_ROOT_EXPORTS = {
    "browserRemoteObservabilityPublicConsumerCompatibility",
    "browserRemoteObservabilityPublicPacket",
    "BrowserRemoteDirectoryHealthBundle",
    "BrowserRemoteObservabilityPublicConsumer",
    "BrowserRemoteObservabilityPublicPacket",
    "BrowserRemoteObservabilityPublicRequirement",
}
FORBIDDEN_FILES = {
    "src/controlbot/client.ts",
    "src/execution-loop.ts",
    "src/recovery/live-object-storage.ts",
    "src/runtime-supervisor.ts",
    "src/adapters/recovery-database.ts",
    "src/adapters/recovery-google-drive.ts",
    "src/adapters/recovery-object-storage.ts",
}


class FactoryRunnerObservabilityPackageBoundaryTests(unittest.TestCase):
    def manifest(self) -> dict:
        return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    def public_symbols(self, entrypoint: str) -> set[str]:
        source = (ROOT / entrypoint).read_text(encoding="utf-8")
        self.assertNotIn("export *", source)
        result: set[str] = set()
        for match in EXPORT_RE.finditer(source):
            for raw in match.group("body").split(","):
                item = raw.strip()
                if not item:
                    continue
                if item.startswith("type "):
                    item = item[5:].strip()
                result.add(item.split(" as ", 1)[-1].strip())
        return result

    def resolve(self, source: str, specifier: str) -> str:
        path = posixpath.normpath(posixpath.join(posixpath.dirname(source), specifier))
        self.assertTrue(path.startswith("src/"), f"dependencia fuera de src/: {path}")
        if not path.endswith(".ts"):
            path += ".ts"
        return path

    def closure(self, entrypoint: str) -> set[str]:
        pending = [entrypoint]
        visited: set[str] = set()
        while pending:
            relative = pending.pop()
            if relative in visited:
                continue
            path = ROOT / relative
            self.assertTrue(path.is_file(), f"falta fuente requerida: {relative}")
            visited.add(relative)
            for specifier in IMPORT_RE.findall(path.read_text(encoding="utf-8")):
                dependency = self.resolve(relative, specifier)
                if dependency not in visited:
                    pending.append(dependency)
        return visited

    def combined_closure(self) -> list[str]:
        union: set[str] = set()
        for entrypoint in ENTRYPOINTS.values():
            union.update(self.closure(entrypoint))
        return sorted(union)

    def test_package_manifest_exposes_only_supported_public_entrypoints_and_runtime_free_metadata(self) -> None:
        manifest = self.manifest()
        self.assertIs(manifest.get("private"), True)
        self.assertEqual(manifest.get("type"), "module")
        self.assertEqual(
            manifest.get("exports"),
            {key: f"./{entrypoint}" for key, entrypoint in ENTRYPOINTS.items()},
        )
        self.assertNotIn("publishConfig", manifest)
        self.assertNotIn("bin", manifest)
        self.assertEqual(self.public_symbols(ROOT_ENTRYPOINT), EXPECTED_ROOT_EXPORTS)

        files = manifest.get("files")
        self.assertIsInstance(files, list)
        self.assertEqual(files, sorted(set(files)))
        self.assertEqual(files, self.combined_closure())

        scripts = manifest.get("scripts")
        self.assertIsInstance(scripts, dict)
        for name, command in scripts.items():
            self.assertNotRegex(name, re.compile(r"publish|prepack|postpack|prepare", re.I))
            self.assertNotRegex(
                str(command),
                re.compile(r"npm\s+(publish|login|adduser)|--registry|curl|wget", re.I),
            )

    def test_package_boundary_excludes_unrelated_runtime_secrets_docs_and_unintended_files(self) -> None:
        files = self.manifest()["files"]
        self.assertTrue(FORBIDDEN_FILES.isdisjoint(files))
        controlbot_files = {
            path for path in files if path.startswith("src/controlbot/")
        }
        self.assertEqual(
            controlbot_files,
            {
                "src/controlbot/fenced-execution-binding.ts",
                "src/controlbot/http-protocol-v1.ts",
                "src/controlbot/http-session-client.ts",
                "src/controlbot/transport.ts",
            },
        )
        self.assertFalse(any(path.startswith("src/recovery/") for path in files))
        for path in files:
            self.assertTrue(path.startswith("src/"))
            self.assertTrue(path.endswith(".ts"))
            self.assertNotIn("*", path)
            self.assertNotIn("?", path)
            self.assertTrue((ROOT / path).is_file())
        self.assertEqual(files, self.combined_closure())
        self.assertEqual(self.public_symbols(ROOT_ENTRYPOINT), EXPECTED_ROOT_EXPORTS)


if __name__ == "__main__":
    unittest.main()
