import hashlib
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINDING = ROOT / "scripts" / "create-observability-receipt-source-binding.ts"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


class FactoryRunnerObservabilityReceiptSourceBindingTests(unittest.TestCase):
    def _run(
        self,
        receipt: Path,
        snapshot: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "binding-secret-user-f03a9c"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BINDING),
                "--verified-receipt",
                str(receipt),
                "--source-snapshot",
                str(snapshot),
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
                f"{BINDING.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def _package(self) -> dict[str, object]:
        return {
            "name": "@pl0n3r/factoryrunner",
            "version": "0.1.0",
            "private": True,
            "type": "module",
        }

    def _verified_receipt(self) -> dict[str, object]:
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
            {
                "path": "README.md",
                "sha256": "3" * 64,
                "size": 10,
            },
            {
                "path": "package.json",
                "sha256": "4" * 64,
                "size": 20,
            },
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

    def _write(
        self,
        root: Path,
        *,
        receipt: dict[str, object] | None = None,
        snapshot: dict[str, object] | None = None,
    ) -> tuple[Path, Path]:
        receipt_path = root / "verified-receipt.json"
        snapshot_path = root / "source-snapshot.json"
        receipt_path.write_text(
            json.dumps(
                self._verified_receipt() if receipt is None else receipt,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        snapshot_path.write_text(
            canonical(self._snapshot() if snapshot is None else snapshot),
            encoding="utf-8",
        )
        return receipt_path, snapshot_path

    def test_binding_links_verified_receipt_package_identity_and_exact_main_source_fingerprint(
        self,
    ) -> None:
        source = BINDING.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "spawn",
            "exec",
            "fetch(",
            "npm ",
            "git ",
            "curl ",
            "wget ",
            "registry",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot = self._write(root)
            output = root / "binding.json"
            self._run(receipt, snapshot, output)

            body = output.read_text(encoding="utf-8")
            payload = json.loads(body)
            snapshot_body = snapshot.read_bytes()

            self.assertEqual(body, canonical(payload))
            self.assertLessEqual(len(output.read_bytes()), 4096)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["package"], self._package())
            self.assertEqual(
                payload["receipt"],
                {
                    "artifact_sha256": "2" * 64,
                    "sha256": "1" * 64,
                },
            )
            expected_snapshot = self._snapshot()
            self.assertEqual(
                payload["source_snapshot"],
                {
                    "commit_sha": "5" * 40,
                    "sha256": hashlib.sha256(snapshot_body).hexdigest(),
                    "source_sha256": expected_snapshot["source"]["sha256"],
                    "tree_sha": "6" * 40,
                },
            )
            self.assertEqual(
                payload["verification"],
                {
                    "package_match": True,
                    "receipt_verified": True,
                    "source_exact_main": True,
                },
            )
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = body.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("binding-secret-user-f03a9c", lowered)
            self.assertNotIn("timestamp", lowered)
            self.assertNotIn("created_at", lowered)

    def test_mixed_stale_or_tampered_receipt_source_evidence_fails_closed(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            mixed_snapshot = self._snapshot()
            mixed_snapshot["package"] = {
                **self._package(),
                "version": "0.1.1",
            }
            receipt, snapshot = self._write(root, snapshot=mixed_snapshot)
            mixed_output = root / "mixed.json"
            mixed = self._run(receipt, snapshot, mixed_output, check=False)
            self.assertNotEqual(mixed.returncode, 0)
            self.assertFalse(mixed_output.exists())

            stale_root = root / "stale"
            stale_root.mkdir()
            stale_snapshot = self._snapshot()
            stale_snapshot["verification"]["exact_main"] = False
            receipt, snapshot = self._write(stale_root, snapshot=stale_snapshot)
            stale_output = stale_root / "stale.json"
            stale = self._run(receipt, snapshot, stale_output, check=False)
            self.assertNotEqual(stale.returncode, 0)
            self.assertFalse(stale_output.exists())

            tampered_root = root / "tampered"
            tampered_root.mkdir()
            tampered_snapshot = self._snapshot()
            tampered_snapshot["source"]["files"][0]["size"] = 999
            receipt, snapshot = self._write(
                tampered_root,
                snapshot=tampered_snapshot,
            )
            tampered_output = tampered_root / "tampered.json"
            tampered = self._run(
                receipt,
                snapshot,
                tampered_output,
                check=False,
            )
            self.assertNotEqual(tampered.returncode, 0)
            self.assertFalse(tampered_output.exists())

            extra_root = root / "extra"
            extra_root.mkdir()
            extra_receipt = self._verified_receipt()
            extra_receipt["unexpected"] = True
            receipt, snapshot = self._write(extra_root, receipt=extra_receipt)
            extra_output = extra_root / "extra.json"
            extra = self._run(receipt, snapshot, extra_output, check=False)
            self.assertNotEqual(extra.returncode, 0)
            self.assertFalse(extra_output.exists())

            invalid_root = root / "invalid"
            invalid_root.mkdir()
            invalid_receipt = self._verified_receipt()
            invalid_receipt["verified"] = False
            receipt, snapshot = self._write(
                invalid_root,
                receipt=invalid_receipt,
            )
            invalid_output = invalid_root / "invalid.json"
            invalid = self._run(
                receipt,
                snapshot,
                invalid_output,
                check=False,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertFalse(invalid_output.exists())


if __name__ == "__main__":
    unittest.main()
