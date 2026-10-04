import hashlib
import json
import os
import posixpath
import re
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"
BUILDER = ROOT / "scripts" / "build-observability-package.ts"

FORBIDDEN_PATH_PARTS = (
    "controlbot",
    "runtime-supervisor",
    "execution-loop",
    "journal",
    "outbox",
    "recovery/",
)
FORBIDDEN_SCRIPT_RE = (
    "npm publish",
    "npm login",
    "npm adduser",
    "--registry",
    "curl ",
    "wget ",
)
RELATIVE_TS_IMPORT_RE = re.compile(
    r"""(?:from\s*|import\s*\()\s*["'](\.[^"']+\.ts)["']"""
)


class FactoryRunnerObservabilityLocalPackTests(unittest.TestCase):
    def manifest(self) -> dict:
        return json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))

    def _build_stage(self, parent: Path, name: str) -> Path:
        stage = parent / name
        self.assertFalse(stage.exists())
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BUILDER),
                "--output",
                str(stage),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertTrue((stage / "package.json").is_file())
        return stage

    def _pack_stage(
        self,
        stage: Path,
        destination: Path,
    ) -> tuple[dict, dict[str, str], set[str]]:
        destination.mkdir()
        cache = destination / "npm-cache"
        cache.mkdir()
        env = os.environ.copy()
        env.update(
            {
                "npm_config_offline": "true",
                "npm_config_ignore_scripts": "true",
                "npm_config_audit": "false",
                "npm_config_fund": "false",
                "npm_config_update_notifier": "false",
                "npm_config_cache": str(cache),
            }
        )
        completed = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--offline",
                "--ignore-scripts",
                "--pack-destination",
                str(destination),
                ".",
            ],
            cwd=stage,
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, list)
        self.assertEqual(len(payload), 1)

        filename = payload[0].get("filename")
        self.assertIsInstance(filename, str)
        archive = destination / filename
        self.assertTrue(archive.is_file())

        hashes: dict[str, str] = {}
        members: set[str] = set()
        packed_manifest: dict | None = None
        with tarfile.open(archive, mode="r:gz") as handle:
            for member in handle.getmembers():
                if not member.isfile():
                    continue
                self.assertTrue(member.name.startswith("package/"))
                relative = member.name.removeprefix("package/")
                members.add(relative)
                extracted = handle.extractfile(member)
                self.assertIsNotNone(extracted)
                body = extracted.read()
                hashes[relative] = hashlib.sha256(body).hexdigest()
                if relative == "package.json":
                    packed_manifest = json.loads(body.decode("utf-8"))

        self.assertIsNotNone(packed_manifest)
        return packed_manifest, hashes, members

    def _expected_js_files(self) -> list[str]:
        files = self.manifest().get("files")
        self.assertIsInstance(files, list)
        self.assertTrue(all(isinstance(path, str) for path in files))
        return [path.removesuffix(".ts") + ".js" for path in files]

    def _expected_members(self) -> set[str]:
        return {"package.json", "README.md", *self._expected_js_files()}

    def _assert_stage_is_runtime_js_only(self, stage: Path) -> None:
        staged = json.loads((stage / "package.json").read_text(encoding="utf-8"))
        self.assertIs(staged.get("private"), True)
        self.assertEqual(staged.get("type"), "module")
        self.assertEqual(
            staged.get("exports"),
            {".": "./src/browser-remote-observability-public.js"},
        )
        self.assertEqual(staged.get("files"), self._expected_js_files())
        self.assertNotIn("scripts", staged)
        self.assertNotIn("dependencies", staged)
        self.assertNotIn("devDependencies", staged)
        self.assertNotIn("publishConfig", staged)
        self.assertNotIn("bin", staged)

        public_entrypoint = (
            stage / "src" / "browser-remote-observability-public.js"
        ).read_text(encoding="utf-8")
        self.assertIn("export {", public_entrypoint)
        self.assertNotIn("exports.", public_entrypoint)
        self.assertNotIn("module.exports", public_entrypoint)

        allowed = set(self._expected_js_files())
        for relative in allowed:
            source = (stage / relative).read_text(encoding="utf-8")
            self.assertIsNone(
                RELATIVE_TS_IMPORT_RE.search(source),
                f"import TS residual en {relative}",
            )
            for specifier in re.findall(
                r"""(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']""",
                source,
            ):
                if not specifier.endswith(".js"):
                    continue
                target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(relative), specifier)
                )
                self.assertIn(
                    target,
                    allowed,
                    f"import emitido fuera de la allowlist: {relative} -> {target}",
                )

    def test_builder_is_self_contained_without_node_modules_transpiler(self) -> None:
        source = BUILDER.read_text(encoding="utf-8")
        self.assertIn("stripTypeScriptTypes", source)
        self.assertNotIn("from 'typescript'", source)
        self.assertNotIn('from "typescript"', source)
        self.assertNotIn("transpileModule", source)

    def test_local_pack_contains_only_allowlisted_public_sources_and_metadata(self) -> None:
        manifest = self.manifest()
        self.assertIs(manifest.get("private"), True)
        self.assertEqual(
            manifest.get("exports"),
            {".": "./src/browser-remote-observability-public.ts"},
        )
        self.assertNotIn("publishConfig", manifest)
        self.assertNotIn("bin", manifest)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage = self._build_stage(root, "stage")
            self._assert_stage_is_runtime_js_only(stage)
            packed_manifest, _hashes, members = self._pack_stage(
                stage,
                root / "pack",
            )

        self.assertEqual(members, self._expected_members())
        self.assertEqual(packed_manifest["name"], manifest["name"])
        self.assertEqual(packed_manifest["version"], manifest["version"])
        self.assertIs(packed_manifest.get("private"), True)
        self.assertEqual(
            packed_manifest.get("exports"),
            {".": "./src/browser-remote-observability-public.js"},
        )
        self.assertEqual(
            packed_manifest.get("files"),
            self._expected_js_files(),
        )

        lowered = "\n".join(sorted(members)).lower()
        for forbidden in FORBIDDEN_PATH_PARTS:
            self.assertNotIn(forbidden, lowered)
        self.assertFalse(any(path.startswith("tests/") for path in members))
        self.assertFalse(any(path.startswith("docs/") for path in members))
        self.assertFalse(any(path.startswith(".github/") for path in members))

    def test_two_local_packs_have_equivalent_manifest_and_no_publish_or_network_step(self) -> None:
        manifest = self.manifest()
        scripts = manifest.get("scripts", {})
        self.assertIsInstance(scripts, dict)
        script_text = "\n".join(
            f"{name} {command}" for name, command in scripts.items()
        ).lower()
        for forbidden in FORBIDDEN_SCRIPT_RE:
            self.assertNotIn(forbidden, script_text)
        for script_name in scripts:
            self.assertNotRegex(
                script_name.lower(),
                r"^(pre|post)?publish$|^(pre|post)?pack$|^prepare$",
            )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_stage = self._build_stage(root, "stage-a")
            second_stage = self._build_stage(root, "stage-b")
            first_manifest, first_hashes, first_members = self._pack_stage(
                first_stage,
                root / "pack-a",
            )
            second_manifest, second_hashes, second_members = self._pack_stage(
                second_stage,
                root / "pack-b",
            )

        self.assertEqual(first_members, second_members)
        self.assertEqual(first_manifest, second_manifest)
        self.assertEqual(first_hashes, second_hashes)
        self.assertEqual(first_members, self._expected_members())


if __name__ == "__main__":
    unittest.main()
