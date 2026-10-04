import hashlib
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "scripts" / "check-observability-release-candidate-preflight.ts"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


class FactoryRunnerObservabilityReleaseCandidatePreflightTests(unittest.TestCase):
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
        snapshot_bytes: bytes,
        *,
        receipt: dict[str, object] | None = None,
        snapshot: dict[str, object] | None = None,
    ) -> dict[str, object]:
        receipt_value = self._receipt() if receipt is None else receipt
        snapshot_value = self._snapshot() if snapshot is None else snapshot
        return {
            "schema_version": 1,
            "package": receipt_value["package"],
            "receipt": {
                "sha256": receipt_value["receipt_sha256"],
                "artifact_sha256": receipt_value["artifact_sha256"],
            },
            "source_snapshot": {
                "sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
                "source_sha256": snapshot_value["source"]["sha256"],
                "commit_sha": snapshot_value["repository"]["commit_sha"],
                "tree_sha": snapshot_value["repository"]["tree_sha"],
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

    def _write(
        self,
        root: Path,
        *,
        receipt: dict[str, object] | None = None,
        snapshot: dict[str, object] | None = None,
        binding_mutation=None,
    ) -> tuple[Path, Path, Path]:
        receipt_value = self._receipt() if receipt is None else receipt
        snapshot_value = self._snapshot() if snapshot is None else snapshot
        snapshot_body = canonical(snapshot_value).encode("utf-8")
        binding_value = self._binding(
            snapshot_body,
            receipt=receipt_value,
            snapshot=snapshot_value,
        )
        if binding_mutation is not None:
            binding_mutation(binding_value)

        receipt_path = root / "verified-receipt.json"
        snapshot_path = root / "source-snapshot.json"
        binding_path = root / "binding.json"
        receipt_path.write_text(
            json.dumps(receipt_value, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        snapshot_path.write_bytes(snapshot_body)
        binding_path.write_text(canonical(binding_value), encoding="utf-8")
        return receipt_path, snapshot_path, binding_path

    def _run(
        self,
        receipt: Path,
        snapshot: Path,
        binding: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "preflight-secret-user-85a6c1"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(PREFLIGHT),
                "--verified-receipt",
                str(receipt),
                "--source-snapshot",
                str(snapshot),
                "--binding",
                str(binding),
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
                f"{PREFLIGHT.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_preflight_accepts_only_verified_receipt_bound_to_exact_main_source(
        self,
    ) -> None:
        source = PREFLIGHT.read_text(encoding="utf-8").lower()
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
            receipt, snapshot, binding = self._write(root)
            completed = self._run(receipt, snapshot, binding)
            payload = json.loads(completed.stdout)

            self.assertEqual(
                completed.stdout,
                json.dumps(payload, separators=(",", ":")) + "\n",
            )
            self.assertLessEqual(len(completed.stdout.encode("utf-8")), 4096)
            self.assertIs(payload["accepted"], True)
            self.assertEqual(payload["package"], self._package())
            self.assertEqual(
                payload["repository"],
                {"commit_sha": "5" * 40, "tree_sha": "6" * 40},
            )
            self.assertEqual(payload["evidence"]["receipt_sha256"], "1" * 64)
            self.assertEqual(payload["evidence"]["artifact_sha256"], "2" * 64)
            self.assertEqual(
                payload["evidence"]["source_snapshot_sha256"],
                hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                payload["evidence"]["binding_sha256"],
                hashlib.sha256(binding.read_bytes()).hexdigest(),
            )
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = completed.stdout.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("preflight-secret-user-85a6c1", lowered)

    def test_source_or_receipt_drift_blocks_without_publish_registry_or_network_authority(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            source_drift = root / "source-drift"
            source_drift.mkdir()
            receipt, snapshot, binding = self._write(source_drift)
            changed = json.loads(snapshot.read_text(encoding="utf-8"))
            changed["repository"]["commit_sha"] = "7" * 40
            snapshot.write_text(canonical(changed), encoding="utf-8")
            rejected = self._run(receipt, snapshot, binding, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            receipt_drift = root / "receipt-drift"
            receipt_drift.mkdir()
            receipt, snapshot, binding = self._write(receipt_drift)
            changed_receipt = json.loads(receipt.read_text(encoding="utf-8"))
            changed_receipt["artifact_sha256"] = "8" * 64
            receipt.write_text(
                json.dumps(changed_receipt, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            rejected = self._run(receipt, snapshot, binding, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            binding_drift = root / "binding-drift"
            binding_drift.mkdir()
            receipt, snapshot, binding = self._write(
                binding_drift,
                binding_mutation=lambda value: value["source_snapshot"].update(
                    {"tree_sha": "9" * 40}
                ),
            )
            rejected = self._run(receipt, snapshot, binding, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            schema_drift = root / "schema-drift"
            schema_drift.mkdir()
            receipt, snapshot, binding = self._write(
                schema_drift,
                binding_mutation=lambda value: value.update({"unexpected": True}),
            )
            rejected = self._run(receipt, snapshot, binding, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")


if __name__ == "__main__":
    unittest.main()
