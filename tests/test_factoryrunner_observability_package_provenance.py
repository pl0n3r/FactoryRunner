import copy
import gzip
import hashlib
import io
import json
import os
import socket
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
PROVENANCE = ROOT / "scripts" / "build-observability-package-provenance.ts"


class FactoryRunnerObservabilityPackageProvenanceTests(unittest.TestCase):
    def _npm_env(self, cache: Path) -> dict[str, str]:
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
        return env

    def _build_and_pack(self, root: Path) -> tuple[Path, Path]:
        stage = root / "stage"
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
        pack = root / "pack"
        pack.mkdir()
        completed = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--offline",
                "--ignore-scripts",
                "--pack-destination",
                str(pack),
                ".",
            ],
            cwd=stage,
            env=self._npm_env(root / "npm-cache"),
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
        tarball = pack / filename
        self.assertTrue(tarball.is_file())
        return stage, tarball

    def _provenance(
        self,
        stage: Path,
        tarball: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "provenance-secret-user-7f8e91"
        return subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(PROVENANCE),
                "--tarball",
                str(tarball),
                "--stage",
                str(stage),
                "--output",
                str(output),
            ],
            cwd=ROOT,
            env=env,
            check=check,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def _tamper_package_json(self, source: Path, destination: Path) -> None:
        with tarfile.open(source, mode="r:gz") as original:
            with tarfile.open(
                destination,
                mode="w:gz",
                format=tarfile.USTAR_FORMAT,
            ) as rewritten:
                for member in original.getmembers():
                    cloned = copy.copy(member)
                    if not member.isfile():
                        rewritten.addfile(cloned)
                        continue
                    extracted = original.extractfile(member)
                    self.assertIsNotNone(extracted)
                    body = extracted.read()
                    if member.name == "package/package.json":
                        payload = json.loads(body.decode("utf-8"))
                        payload["unexpected_metadata"] = "must-fail-closed"
                        body = (
                            json.dumps(payload, separators=(",", ":"), sort_keys=True)
                            + "\n"
                        ).encode("utf-8")
                    cloned.size = len(body)
                    rewritten.addfile(cloned, io.BytesIO(body))

    def _rewrite_as_pax(self, source: Path, destination: Path) -> None:
        with tarfile.open(source, mode="r:gz") as original:
            with tarfile.open(
                destination,
                mode="w:gz",
                format=tarfile.PAX_FORMAT,
                pax_headers={"comment": "provenance-must-reject-pax"},
            ) as rewritten:
                for member in original.getmembers():
                    cloned = copy.copy(member)
                    if member.isfile():
                        extracted = original.extractfile(member)
                        self.assertIsNotNone(extracted)
                        rewritten.addfile(cloned, io.BytesIO(extracted.read()))
                    else:
                        rewritten.addfile(cloned)

    def _corrupt_tar_header_checksum(self, source: Path, destination: Path) -> None:
        archive = bytearray(gzip.decompress(source.read_bytes()))
        self.assertGreaterEqual(len(archive), 512)
        index = 136
        archive[index] = ord("1") if archive[index] != ord("1") else ord("2")
        destination.write_bytes(gzip.compress(bytes(archive), mtime=0))

    def _archive_hashes(self, tarball: Path) -> dict[str, tuple[int, str]]:
        result: dict[str, tuple[int, str]] = {}
        with tarfile.open(tarball, mode="r:gz") as handle:
            for member in handle.getmembers():
                if not member.isfile():
                    continue
                self.assertTrue(member.name.startswith("package/"))
                relative = member.name.removeprefix("package/")
                extracted = handle.extractfile(member)
                self.assertIsNotNone(extracted)
                body = extracted.read()
                result[relative] = (len(body), hashlib.sha256(body).hexdigest())
        return result

    def test_provenance_binds_exact_package_metadata_file_list_and_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, tarball = self._build_and_pack(root)
            output = root / "provenance.json"
            self._provenance(stage, tarball, output)
            provenance = json.loads(output.read_text(encoding="utf-8"))
            staged = json.loads((stage / "package.json").read_text(encoding="utf-8"))
            hashes = self._archive_hashes(tarball)

            self.assertEqual(provenance["schema_version"], 1)
            self.assertEqual(
                provenance["artifact"]["sha256"],
                hashlib.sha256(tarball.read_bytes()).hexdigest(),
            )
            self.assertEqual(provenance["artifact"]["filename"], tarball.name)
            self.assertEqual(provenance["artifact"]["size"], tarball.stat().st_size)
            self.assertEqual(
                provenance["package"],
                {
                    "name": staged["name"],
                    "version": staged["version"],
                    "private": True,
                    "type": "module",
                    "exports": staged["exports"],
                },
            )
            self.assertEqual(provenance["allowlist"], staged["files"])
            self.assertEqual(
                [item["path"] for item in provenance["files"]],
                sorted(hashes),
            )
            for item in provenance["files"]:
                self.assertEqual(
                    (item["size"], item["sha256"]),
                    hashes[item["path"]],
                )
            self.assertEqual(
                set(hashes),
                {"README.md", "package.json", *staged["files"]},
            )
            self.assertIs(provenance["network_access"], False)
            self.assertIs(provenance["external_mutation"], False)

            tampered_tarball = root / "tampered-package-json.tgz"
            self._tamper_package_json(tarball, tampered_tarball)
            tampered = self._provenance(
                stage,
                tampered_tarball,
                root / "tampered.json",
                check=False,
            )
            self.assertNotEqual(tampered.returncode, 0)
            self.assertFalse((root / "tampered.json").exists())

            staged["version"] = "9.9.9"
            (stage / "package.json").write_text(
                json.dumps(staged, indent=2) + "\n",
                encoding="utf-8",
            )
            failed = self._provenance(
                stage,
                tarball,
                root / "must-not-exist.json",
                check=False,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse((root / "must-not-exist.json").exists())

    def test_provenance_is_deterministic_sanitized_and_registry_free(self) -> None:
        source = PROVENANCE.read_text(encoding="utf-8").lower()
        for forbidden in (
            "npm publish",
            "npm login",
            "npm adduser",
            "--registry",
            "curl ",
            "wget ",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, tarball = self._build_and_pack(root)
            first = root / "first.json"
            second = root / "second.json"
            self._provenance(stage, tarball, first)
            self._provenance(stage, tarball, second)
            first_body = first.read_text(encoding="utf-8")
            second_body = second.read_text(encoding="utf-8")
            payload = json.loads(first_body)

            self.assertEqual(first_body, second_body)
            self.assertEqual(
                first_body,
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
            )
            lowered = first_body.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn("http://", lowered)
            self.assertNotIn("https://", lowered)
            self.assertNotIn("registry", lowered)
            self.assertNotIn("timestamp", lowered)
            self.assertNotIn("created_at", lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("provenance-secret-user-7f8e91", lowered)

            extra = stage / "unexpected.txt"
            extra.write_text("not allowlisted\n", encoding="utf-8")
            failed = self._provenance(
                stage,
                tarball,
                root / "extra.json",
                check=False,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse((root / "extra.json").exists())

    def test_provenance_rejects_pax_headers_without_interpreting_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, tarball = self._build_and_pack(root)
            pax_tarball = root / "pax.tgz"
            self._rewrite_as_pax(tarball, pax_tarball)

            output = root / "pax-provenance.json"
            failed = self._provenance(stage, pax_tarball, output, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(output.exists())

    def test_provenance_rejects_invalid_tar_checksum_and_oversized_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, tarball = self._build_and_pack(root)

            corrupt_tarball = root / "bad-checksum.tgz"
            self._corrupt_tar_header_checksum(tarball, corrupt_tarball)
            corrupt_output = root / "bad-checksum.json"
            failed_checksum = self._provenance(
                stage,
                corrupt_tarball,
                corrupt_output,
                check=False,
            )
            self.assertNotEqual(failed_checksum.returncode, 0)
            self.assertFalse(corrupt_output.exists())

            oversized_tarball = root / "oversized.tgz"
            oversized_tarball.write_bytes(
                gzip.compress(b"\0" * (16 * 1024 * 1024 + 512), mtime=0)
            )
            oversized_output = root / "oversized.json"
            failed_oversized = self._provenance(
                stage,
                oversized_tarball,
                oversized_output,
                check=False,
            )
            self.assertNotEqual(failed_oversized.returncode, 0)
            self.assertFalse(oversized_output.exists())


if __name__ == "__main__":
    unittest.main()
