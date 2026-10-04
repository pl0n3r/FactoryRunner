import json
import posixpath
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "package.json"
IMPORT_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']""")
NETWORK_OR_PUBLISH_RE = re.compile(
    r"""(?ix)
    \bnpm\s+(?:publish|login|adduser)\b
    |--registry\b
    |registry\.npmjs\.org
    |\bcurl\b
    |\bwget\b
    """
)
FORBIDDEN_EXACT = {
    "AGENTES.md",
    "README.md",
    "datos.yml",
    "decisiones.yml",
    "package-lock.json",
    "tsconfig.json",
}
FORBIDDEN_PREFIXES = (
    ".github/",
    "config/",
    "dist/",
    "docs/",
    "readme/",
    "scripts/",
    "tests/",
)
UNINTENDED_SOURCE_FILES = {
    "src/admission-evidence.ts",
    "src/browser-placement-guard.ts",
    "src/browser-placement-policy.ts",
    "src/browser-placement-profile.ts",
    "src/browser-remote-runtime-recovery.ts",
    "src/controlbot/connection-profile.ts",
    "src/controlbot/https-transport.ts",
    "src/offline-doctor.ts",
    "src/readiness-snapshot.ts",
}


class FactoryRunnerObservabilityPackageBoundaryTests(unittest.TestCase):
    def _manifest(self) -> dict:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def _resolve_relative_typescript(self, source: str, specifier: str) -> str:
        normalized = posixpath.normpath(
            posixpath.join(posixpath.dirname(source), specifier)
        )
        if normalized.startswith("../") or normalized == "..":
            self.fail(f"Import relativo escapa del repositorio: {source} -> {specifier}")
        if not normalized.startswith("src/"):
            self.fail(f"El entrypoint público depende de código fuera de src/: {normalized}")
        if not normalized.endswith(".ts"):
            normalized += ".ts"
        return normalized

    def _public_source_closure(self) -> list[str]:
        pending = ["src/index.ts"]
        visited: set[str] = set()

        while pending:
            relative = pending.pop()
            if relative in visited:
                continue

            source = ROOT / relative
            self.assertTrue(source.is_file(), f"Falta fuente requerida por el barrel: {relative}")
            visited.add(relative)

            for specifier in IMPORT_RE.findall(source.read_text(encoding="utf-8")):
                dependency = self._resolve_relative_typescript(relative, specifier)
                if dependency not in visited:
                    pending.append(dependency)

        return sorted(visited)

    def test_package_manifest_exposes_only_supported_public_entrypoint_and_runtime_free_metadata(self) -> None:
        manifest = self._manifest()

        self.assertIs(manifest.get("private"), True)
        self.assertEqual(manifest.get("type"), "module")
        self.assertEqual(manifest.get("exports"), {".": "./src/index.ts"})
        self.assertNotIn("publishConfig", manifest)
        self.assertNotIn("bin", manifest)

        files = manifest.get("files")
        self.assertIsInstance(files, list)
        self.assertTrue(files)
        self.assertEqual(files, sorted(set(files)))
        self.assertEqual(files, self._public_source_closure())

        scripts = manifest.get("scripts")
        self.assertIsInstance(scripts, dict)
        for name, command in scripts.items():
            self.assertNotRegex(name, re.compile(r"publish|prepack|postpack|prepare", re.I))
            self.assertNotRegex(str(command), NETWORK_OR_PUBLISH_RE)

    def test_package_boundary_excludes_internal_runtime_secrets_docs_and_unintended_files(self) -> None:
        manifest = self._manifest()
        files = manifest["files"]

        for relative in files:
            self.assertFalse("*" in relative or "?" in relative, f"Allowlist no concreta: {relative}")
            self.assertTrue(relative.startswith("src/"), f"Archivo fuera de src/: {relative}")
            self.assertTrue(relative.endswith(".ts"), f"Fuente no TypeScript inesperada: {relative}")
            self.assertTrue((ROOT / relative).is_file(), f"Archivo allowlisted inexistente: {relative}")
            self.assertNotRegex(
                relative,
                re.compile(r"(?i)(?:^|/)(?:\.env(?:\.|$)|secrets?|credentials?|tokens?|cookies?)(?:/|$)"),
            )

        file_set = set(files)
        self.assertTrue(FORBIDDEN_EXACT.isdisjoint(file_set))
        self.assertFalse(
            any(path.startswith(FORBIDDEN_PREFIXES) for path in files),
            "La frontera incluye docs/tests/config/runtime artifacts fuera de src/",
        )
        self.assertTrue(
            UNINTENDED_SOURCE_FILES.isdisjoint(file_set),
            "La frontera publicó internos no alcanzables desde src/index.ts",
        )
        self.assertEqual(files, self._public_source_closure())


if __name__ == "__main__":
    unittest.main()
