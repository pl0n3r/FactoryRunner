import hashlib
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "create-observability-release-handoff-packet.ts"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


class FactoryRunnerObservabilityReleaseHandoffPacketTests(unittest.TestCase):
    def _package(self) -> dict[str, object]:
        return {
            "name": "@pl0n3r/factoryrunner",
            "version": "0.1.0",
            "private": True,
            "type": "module",
        }

    def _receipt(self) -> dict[str, object]:
        return {
            "verified": True,
            "receipt_sha256": "1" * 64,
            "artifact_sha256": "2" * 64,
            "package": self._package(),
            "authority": "unchanged",
            "network_access": False,
            "external_mutation": False,
        }

    def _snapshot(self) -> dict[str, object]:
        files = [
            {"path": "README.md", "sha256": "3" * 64, "size": 10},
            {"path": "package.json", "sha256": "4" * 64, "size": 20},
        ]
        return {
            "schema_version": 1,
            "package": self._package(),
            "repository": {
                "ref": "refs/heads/main",
                "commit_sha": "5" * 40,
                "tree_sha": "6" * 40,
            },
            "source": {
                "sha256": hashlib.sha256(
                    canonical(files).encode("utf-8")
                ).hexdigest(),
                "files": files,
            },
            "verification": {
                "exact_main": True,
                "tracked_sources": True,
                "worktree_clean": True,
            },
            "authority": "unchanged",
            "network_access": False,
            "external_mutation": False,
        }

    def _binding(
        self,
        snapshot_body: bytes,
        receipt: dict[str, object],
        snapshot: dict[str, object],
    ) -> dict[str, object]:
        return {
            "schema_version": 1,
            "package": receipt["package"],
            "receipt": {
                "sha256": receipt["receipt_sha256"],
                "artifact_sha256": receipt["artifact_sha256"],
            },
            "source_snapshot": {
                "sha256": hashlib.sha256(snapshot_body).hexdigest(),
                "source_sha256": snapshot["source"]["sha256"],
                "commit_sha": snapshot["repository"]["commit_sha"],
                "tree_sha": snapshot["repository"]["tree_sha"],
            },
            "verification": {
                "receipt_verified": True,
                "source_exact_main": True,
                "package_match": True,
            },
            "authority": "unchanged",
            "network_access": False,
            "external_mutation": False,
        }

    def _preflight(
        self,
        receipt: dict[str, object],
        snapshot: dict[str, object],
        snapshot_body: bytes,
        binding_body: bytes,
    ) -> dict[str, object]:
        return {
            "accepted": True,
            "package": receipt["package"],
            "repository": {
                "commit_sha": snapshot["repository"]["commit_sha"],
                "tree_sha": snapshot["repository"]["tree_sha"],
            },
            "evidence": {
                "artifact_sha256": receipt["artifact_sha256"],
                "receipt_sha256": receipt["receipt_sha256"],
                "source_snapshot_sha256": hashlib.sha256(snapshot_body).hexdigest(),
                "source_sha256": snapshot["source"]["sha256"],
                "binding_sha256": hashlib.sha256(binding_body).hexdigest(),
            },
            "authority": "unchanged",
            "publish_authority": False,
            "network_access": False,
            "external_mutation": False,
        }

    def _write_evidence(
        self,
        root: Path,
        *,
        mutate_binding=None,
        mutate_preflight=None,
    ) -> tuple[Path, Path, Path, Path]:
        receipt = self._receipt()
        snapshot = self._snapshot()
        snapshot_body = canonical(snapshot).encode("utf-8")
        binding = self._binding(snapshot_body, receipt, snapshot)
        if mutate_binding is not None:
            mutate_binding(binding)
        binding_body = canonical(binding).encode("utf-8")
        preflight = self._preflight(receipt, snapshot, snapshot_body, binding_body)
        if mutate_preflight is not None:
            mutate_preflight(preflight)

        receipt_path = root / "verified-receipt.json"
        snapshot_path = root / "source-snapshot.json"
        binding_path = root / "binding.json"
        preflight_path = root / "preflight.json"
        receipt_path.write_text(
            json.dumps(receipt, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        snapshot_path.write_bytes(snapshot_body)
        binding_path.write_bytes(binding_body)
        preflight_path.write_text(
            json.dumps(preflight, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        return receipt_path, snapshot_path, binding_path, preflight_path

    def _run(
        self,
        receipt: Path,
        snapshot: Path,
        binding: Path,
        preflight: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "handoff-secret-user-4ac731"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BUILDER),
                "--verified-receipt",
                str(receipt),
                "--source-snapshot",
                str(snapshot),
                "--binding",
                str(binding),
                "--preflight",
                str(preflight),
                "--output",
                str(output),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{BUILDER.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_packet_binds_preflight_receipt_source_and_exact_main_identity_deterministically(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight = self._write_evidence(root)
            first = root / "handoff-a.json"
            second = root / "handoff-b.json"

            self._run(receipt, snapshot, binding, preflight, first)
            self._run(receipt, snapshot, binding, preflight, second)

            first_body = first.read_bytes()
            self.assertEqual(first_body, second.read_bytes())
            payload = json.loads(first_body)
            self.assertEqual(first_body.decode("utf-8"), canonical(payload))
            self.assertLessEqual(len(first_body), 4096)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["package"], self._package())
            self.assertEqual(
                payload["repository"],
                {"commit_sha": "5" * 40, "tree_sha": "6" * 40},
            )
            self.assertEqual(payload["evidence"]["artifact_sha256"], "2" * 64)
            self.assertEqual(payload["evidence"]["receipt_sha256"], "1" * 64)
            self.assertEqual(
                payload["evidence"]["source_snapshot_sha256"],
                hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                payload["evidence"]["binding_sha256"],
                hashlib.sha256(binding.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                payload["evidence"]["preflight_sha256"],
                hashlib.sha256(preflight.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                payload["verification"],
                {"exact_main": True, "release_candidate_accepted": True},
            )

    def test_packet_is_bounded_secret_free_and_carries_no_publish_authority(self) -> None:
        source = BUILDER.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "node:child_process",
            "fetch(",
            "npm publish",
            "npm login",
            "git push",
            "curl ",
            "wget ",
            "registry.npmjs.org",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight = self._write_evidence(root)
            output = root / "handoff.json"
            self._run(receipt, snapshot, binding, preflight, output)
            payload = json.loads(output.read_text(encoding="utf-8"))

            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["decision_required"], True)
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)
            lowered = output.read_text(encoding="utf-8").lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("handoff-secret-user-4ac731", lowered)

            already_exists = self._run(
                receipt,
                snapshot,
                binding,
                preflight,
                output,
                check=False,
            )
            self.assertNotEqual(already_exists.returncode, 0)

            stale_root = root / "stale"
            stale_root.mkdir()
            receipt2, snapshot2, binding2, preflight2 = self._write_evidence(
                stale_root,
                mutate_preflight=lambda value: value["repository"].update(
                    {"commit_sha": "7" * 40}
                ),
            )
            rejected = self._run(
                receipt2,
                snapshot2,
                binding2,
                preflight2,
                stale_root / "handoff.json",
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((stale_root / "handoff.json").exists())

            rejected_root = root / "rejected"
            rejected_root.mkdir()
            receipt3, snapshot3, binding3, preflight3 = self._write_evidence(
                rejected_root,
                mutate_preflight=lambda value: value.update({"accepted": False}),
            )
            rejected = self._run(
                receipt3,
                snapshot3,
                binding3,
                preflight3,
                rejected_root / "handoff.json",
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((rejected_root / "handoff.json").exists())

            extra_root = root / "extra"
            extra_root.mkdir()
            receipt4, snapshot4, binding4, preflight4 = self._write_evidence(
                extra_root,
                mutate_binding=lambda value: value.update({"unexpected": True}),
            )
            rejected = self._run(
                receipt4,
                snapshot4,
                binding4,
                preflight4,
                extra_root / "handoff.json",
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((extra_root / "handoff.json").exists())


if __name__ == "__main__":
    unittest.main()
