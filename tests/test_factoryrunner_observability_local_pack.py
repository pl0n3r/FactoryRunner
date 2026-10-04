import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"

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


class FactoryRunnerObservabilityLocalPackTests(unittest.TestCase):
    def manifest(self) -> dict:
        return json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))

    def _pack_once(self, destination: Path) -> tuple[dict, dict[str, str], set[str]]:
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
        command = [
            "npm",
            "pack",
            "--json",
            "--offline",
            "--ignore-scripts",
            "--pack-destination",
            str(destination),
            ".",
        ]
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, list)
        self.assertEqual(len(payload), 1)

        result = payload[0]
        filename = result.get("filename")
        self.assertIsInstance(filename, str)
        archive = destination / filename
        self.assertTrue(archive.is_file())

        hashes: dict[str, str] = {}
        members: set[str] = set()
        with tarfile.open(archive, mode="r:gz") as handle:
            for member in handle.getmembers():
                if not member.isfile():
                    continue
                self.assertTrue(member.name.startswith("package/"))
                relative = member.name.removeprefix("package/")
                members.add(relative)
                extracted = handle.extractfile(member)
                self.assertIsNotNone(extracted)
                hashes[relative] = hashlib.sha256(extracted.read()).hexdigest()

        packed_manifest_member = handle_manifest = "package.json"
        self.assertIn(packed_manifest_member, hashes)
        with tarfile.open(archive, mode="r:gz") as handle:
            manifest_file = handle.extractfile("package/package.json")
            self.assertIsNotNone(manifest_file)
            packed_manifest = json.loads(manifest_file.read().decode("utf-8"))

        return packed_manifest, hashes, members

    def _expected_members(self) -> set[str]:
        manifest = self.manifest()
        files = manifest.get("files")
        self.assertIsInstance(files, list)
        self.assertTrue(all(isinstance(path, str) for path in files))
        metadata = {"package.json"}
        # npm incluye README de forma obligatoria cuando existe, aun con files allowlisted.
        if (ROOT / "README.md").is_file():
            metadata.add("README.md")
        return metadata | set(files)

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
            packed_manifest, _hashes, members = self._pack_once(Path(tmp))

        self.assertEqual(members, self._expected_members())
        self.assertEqual(packed_manifest["name"], manifest["name"])
        self.assertEqual(packed_manifest["version"], manifest["version"])
        self.assertIs(packed_manifest.get("private"), True)
        self.assertEqual(packed_manifest.get("exports"), manifest.get("exports"))
        self.assertEqual(packed_manifest.get("files"), manifest.get("files"))

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

        with tempfile.TemporaryDirectory() as first_tmp, tempfile.TemporaryDirectory() as second_tmp:
            first_manifest, first_hashes, first_members = self._pack_once(Path(first_tmp))
            second_manifest, second_hashes, second_members = self._pack_once(Path(second_tmp))

        self.assertEqual(first_members, second_members)
        self.assertEqual(first_manifest, second_manifest)
        self.assertEqual(first_hashes, second_hashes)
        self.assertEqual(first_members, self._expected_members())


if __name__ == "__main__":
    unittest.main()
