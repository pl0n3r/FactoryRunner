import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINDING = ROOT / "scripts" / "create-observability-fresh-artifact-binding.ts"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


class FactoryRunnerObservabilityFreshArtifactBindingTests(unittest.TestCase):
    def _package(self) -> dict[str, object]:
        return {
            "name": "@pl0n3r/factoryrunner",
            "version": "0.1.0",
            "private": True,
            "type": "module",
        }

    def _repository(self) -> dict[str, str]:
        return {
            "commit_sha": "a" * 40,
            "tree_sha": "b" * 40,
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

    def _handoff(self) -> dict[str, object]:
        return {
            "verified": True,
            "schema_version": 1,
            "handoff_sha256": "3" * 64,
            "package": self._package(),
            "repository": self._repository(),
            "evidence": {
                "artifact_sha256": "2" * 64,
                "receipt_sha256": "1" * 64,
                "source_snapshot_sha256": "4" * 64,
                "source_sha256": "5" * 64,
                "binding_sha256": "6" * 64,
                "preflight_sha256": "7" * 64,
            },
            "authority": "unchanged",
            "decision_required": True,
            "publish_authority": False,
            "network_access": False,
            "external_mutation": False,
        }

    def _fresh(self) -> dict[str, object]:
        return {
            "verified": True,
            "fresh": True,
            "schema_version": 1,
            "handoff_sha256": "3" * 64,
            "repository": self._repository(),
            "authority": "unchanged",
            "decision_required": True,
            "publish_authority": False,
            "network_access": False,
            "external_mutation": False,
        }

    def _write(
        self,
        root: Path,
        *,
        receipt: dict[str, object] | None = None,
        handoff: dict[str, object] | None = None,
        fresh: dict[str, object] | None = None,
    ) -> tuple[Path, Path, Path]:
        receipt_path = root / "verified-receipt.json"
        handoff_path = root / "verified-handoff.json"
        fresh_path = root / "fresh-preview.json"
        receipt_path.write_text(
            json.dumps(self._receipt() if receipt is None else receipt, separators=(",", ":"))
            + "\n",
            encoding="utf-8",
        )
        handoff_path.write_text(
            json.dumps(self._handoff() if handoff is None else handoff, separators=(",", ":"))
            + "\n",
            encoding="utf-8",
        )
        fresh_path.write_text(
            json.dumps(self._fresh() if fresh is None else fresh, separators=(",", ":"))
            + "\n",
            encoding="utf-8",
        )
        return receipt_path, handoff_path, fresh_path

    def _run(
        self,
        receipt: Path,
        handoff: Path,
        fresh: Path,
        output: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "fresh-binding-secret-user-8df913"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BINDING),
                "--verified-receipt",
                str(receipt),
                "--verified-handoff",
                str(handoff),
                "--fresh-preview",
                str(fresh),
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

    def test_binding_requires_same_artifact_receipt_handoff_and_current_main_identity(
        self,
    ) -> None:
        source = BINDING.read_text(encoding="utf-8").lower()
        for forbidden in (
            "node:http",
            "node:https",
            "spawn",
            "exec",
            "fetch(",
            "api.github.com",
            "github.com",
            "npm ",
            "git ",
            "curl ",
            "wget ",
            "registry",
            "process.env",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, handoff, fresh = self._write(root)
            first = root / "binding-a.json"
            second = root / "binding-b.json"
            self._run(receipt, handoff, fresh, first)
            self._run(receipt, handoff, fresh, second)

            first_body = first.read_text(encoding="utf-8")
            second_body = second.read_text(encoding="utf-8")
            payload = json.loads(first_body)

            self.assertEqual(first_body, second_body)
            self.assertEqual(first_body, canonical(payload))
            self.assertLessEqual(len(first.read_bytes()), 4096)
            self.assertEqual(first.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                set(payload),
                {
                    "schema_version",
                    "package",
                    "evidence",
                    "repository",
                    "verification",
                    "authority",
                    "publish_authority",
                    "network_access",
                    "external_mutation",
                },
            )
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["package"], self._package())
            self.assertEqual(
                payload["evidence"],
                {
                    "artifact_sha256": "2" * 64,
                    "handoff_sha256": "3" * 64,
                    "receipt_sha256": "1" * 64,
                },
            )
            self.assertEqual(payload["repository"], self._repository())
            self.assertEqual(
                payload["verification"],
                {
                    "artifact_match": True,
                    "handoff_fresh": True,
                    "handoff_match": True,
                    "handoff_verified": True,
                    "package_match": True,
                    "receipt_match": True,
                    "receipt_verified": True,
                    "repository_match": True,
                },
            )
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = first_body.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("fresh-binding-secret-user-8df913", lowered)

            exists = self._run(receipt, handoff, fresh, first, check=False)
            self.assertNotEqual(exists.returncode, 0)

    def test_mixed_stale_tampered_or_unknown_evidence_fails_closed_without_network_authority(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            mixed_root = root / "mixed"
            mixed_root.mkdir()
            mixed_handoff = self._handoff()
            mixed_handoff["evidence"]["artifact_sha256"] = "8" * 64
            receipt, handoff, fresh = self._write(
                mixed_root,
                handoff=mixed_handoff,
            )
            output = mixed_root / "binding.json"
            rejected = self._run(receipt, handoff, fresh, output, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())

            stale_root = root / "stale"
            stale_root.mkdir()
            stale_fresh = self._fresh()
            stale_fresh["repository"] = {
                "commit_sha": "c" * 40,
                "tree_sha": "d" * 40,
            }
            receipt, handoff, fresh = self._write(
                stale_root,
                fresh=stale_fresh,
            )
            output = stale_root / "binding.json"
            rejected = self._run(receipt, handoff, fresh, output, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())

            tampered_root = root / "tampered"
            tampered_root.mkdir()
            tampered_handoff = self._handoff()
            tampered_handoff["unexpected"] = True
            receipt, handoff, fresh = self._write(
                tampered_root,
                handoff=tampered_handoff,
            )
            output = tampered_root / "binding.json"
            rejected = self._run(receipt, handoff, fresh, output, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())

            unknown_root = root / "unknown"
            unknown_root.mkdir()
            unknown_fresh = self._fresh()
            unknown_fresh["schema_version"] = 2
            receipt, handoff, fresh = self._write(
                unknown_root,
                fresh=unknown_fresh,
            )
            output = unknown_root / "binding.json"
            rejected = self._run(receipt, handoff, fresh, output, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())

            invalid_root = root / "invalid"
            invalid_root.mkdir()
            invalid_receipt = self._receipt()
            invalid_receipt["authority"] = "elevated"
            receipt, handoff, fresh = self._write(
                invalid_root,
                receipt=invalid_receipt,
            )
            output = invalid_root / "binding.json"
            rejected = self._run(receipt, handoff, fresh, output, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(output.exists())

        source = BINDING.read_text(encoding="utf-8").lower()
        self.assertNotIn("publish_authority: true", source)
        self.assertNotIn("network_access: true", source)
        self.assertNotIn("external_mutation: true", source)


if __name__ == "__main__":
    unittest.main()
