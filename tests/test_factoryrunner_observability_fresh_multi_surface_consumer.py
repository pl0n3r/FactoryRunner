import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_factoryrunner_observability_package_release_receipt_verify import (
    FactoryRunnerObservabilityPackageReleaseReceiptVerifyTests as VerifiedReceiptFixture,
)


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "scripts" / "check-observability-package-release-preflight.ts"
RECEIPT_VERIFIER = ROOT / "scripts" / "check-observability-package-release-receipt.ts"
SMOKE = ROOT / "scripts" / "check-observability-fresh-multi-surface-consumer.ts"
ROOT_PACKAGE = "@pl0n3r/factoryrunner"
RECOVERY_SUBPATH = ROOT_PACKAGE + "/recovery-handoff"
COMMIT_SHA = "a" * 40
TREE_SHA = "b" * 40
HANDOFF_SHA = "3" * 64


class FactoryRunnerObservabilityFreshMultiSurfaceConsumerTests(unittest.TestCase):
    def _bundle(self, root: Path) -> tuple[Path, Path, Path, Path]:
        helper = VerifiedReceiptFixture(
            "test_verifier_accepts_only_exact_receipt_and_bound_local_artifacts"
        )
        return helper._bundle(root)

    def _verified_receipt(
        self,
        receipt: Path,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
    ) -> dict[str, object]:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(RECEIPT_VERIFIER),
                "--receipt",
                str(receipt),
                "--artifact",
                str(artifact),
                "--provenance",
                str(provenance),
                "--dependencies",
                str(dependencies),
                "--preflight",
                str(PREFLIGHT),
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, dict)
        return payload

    def _evidence(
        self,
        root: Path,
        verified: dict[str, object],
    ) -> tuple[Path, Path]:
        package = copy.deepcopy(verified["package"])
        handoff = {
            "verified": True,
            "schema_version": 1,
            "handoff_sha256": HANDOFF_SHA,
            "package": package,
            "repository": {
                "commit_sha": COMMIT_SHA,
                "tree_sha": TREE_SHA,
            },
            "evidence": {
                "artifact_sha256": verified["artifact_sha256"],
                "receipt_sha256": verified["receipt_sha256"],
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
        fresh = {
            "verified": True,
            "fresh": True,
            "schema_version": 1,
            "handoff_sha256": HANDOFF_SHA,
            "repository": {
                "commit_sha": COMMIT_SHA,
                "tree_sha": TREE_SHA,
            },
            "authority": "unchanged",
            "decision_required": True,
            "publish_authority": False,
            "network_access": False,
            "external_mutation": False,
        }
        handoff_path = root / "verified-handoff.json"
        fresh_path = root / "fresh-preview.json"
        handoff_path.write_text(
            json.dumps(handoff, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        fresh_path.write_text(
            json.dumps(fresh, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        return handoff_path, fresh_path

    def _run(
        self,
        receipt: Path,
        artifact: Path,
        provenance: Path,
        dependencies: Path,
        handoff: Path,
        fresh: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(SMOKE),
                "--receipt",
                str(receipt),
                "--artifact",
                str(artifact),
                "--provenance",
                str(provenance),
                "--dependencies",
                str(dependencies),
                "--preflight",
                str(PREFLIGHT),
                "--verified-handoff",
                str(handoff),
                "--fresh-preview",
                str(fresh),
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=150,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{SMOKE.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def test_consumer_runs_only_after_fresh_exact_main_binding_and_uses_both_public_surfaces(
        self,
    ) -> None:
        source = SMOKE.read_text(encoding="utf-8")
        self.assertLess(
            source.index("const verifiedReceipt = receiptVerification("),
            source.index("const binding = await readFreshBinding(bindingPath);"),
        )
        self.assertLess(
            source.index("const binding = await readFreshBinding(bindingPath);"),
            source.index("const consumed = consumerResult("),
        )
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm publish",
            "npm login",
            "npm view",
            "registry.npmjs.org",
            "curl ",
            "wget ",
        ):
            self.assertNotIn(forbidden, source.lower())

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            verified = self._verified_receipt(
                receipt,
                artifact,
                provenance,
                dependencies,
            )
            handoff, fresh = self._evidence(root, verified)

            completed = self._run(
                receipt,
                artifact,
                provenance,
                dependencies,
                handoff,
                fresh,
            )
            result = json.loads(completed.stdout)

            self.assertIs(result["verified"], True)
            self.assertIs(result["fresh_exact_main_binding"], True)
            self.assertEqual(
                result["repository"],
                {"commit_sha": COMMIT_SHA, "tree_sha": TREE_SHA},
            )
            self.assertEqual(result["evidence"]["artifact_sha256"], verified["artifact_sha256"])
            self.assertEqual(result["evidence"]["receipt_sha256"], verified["receipt_sha256"])
            self.assertEqual(result["evidence"]["handoff_sha256"], HANDOFF_SHA)
            self.assertIs(result["installed_from_local_artifact"], True)
            self.assertEqual(
                result["public_surfaces_consumed"],
                [ROOT_PACKAGE, RECOVERY_SUBPATH],
            )
            self.assertEqual(result["packet_status"], "READY")
            self.assertEqual(result["recovery_compatibility_status"], "COMPATIBLE")
            self.assertEqual(result["authority"], "unchanged")
            self.assertIs(result["execution"], False)
            self.assertIs(result["network_access"], False)
            self.assertIs(result["external_mutation"], False)

    def test_stale_mixed_or_tampered_binding_blocks_before_consumer_acceptance(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact, provenance, dependencies, receipt = self._bundle(root)
            verified = self._verified_receipt(
                receipt,
                artifact,
                provenance,
                dependencies,
            )

            stale_root = root / "stale"
            stale_root.mkdir()
            handoff, fresh = self._evidence(stale_root, verified)
            stale_payload = json.loads(fresh.read_text(encoding="utf-8"))
            stale_payload["repository"]["commit_sha"] = "c" * 40
            fresh.write_text(
                json.dumps(stale_payload, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            stale = self._run(
                receipt,
                artifact,
                provenance,
                dependencies,
                handoff,
                fresh,
                check=False,
            )
            self.assertNotEqual(stale.returncode, 0)
            self.assertEqual(stale.stdout, "")

            mixed_root = root / "mixed"
            mixed_root.mkdir()
            handoff, fresh = self._evidence(mixed_root, verified)
            mixed_payload = json.loads(handoff.read_text(encoding="utf-8"))
            mixed_payload["evidence"]["artifact_sha256"] = "8" * 64
            handoff.write_text(
                json.dumps(mixed_payload, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            mixed = self._run(
                receipt,
                artifact,
                provenance,
                dependencies,
                handoff,
                fresh,
                check=False,
            )
            self.assertNotEqual(mixed.returncode, 0)
            self.assertEqual(mixed.stdout, "")

            tampered_root = root / "tampered"
            tampered_root.mkdir()
            handoff, fresh = self._evidence(tampered_root, verified)
            tampered_receipt = tampered_root / "receipt.json"
            tampered_payload = json.loads(receipt.read_text(encoding="utf-8"))
            tampered_payload["artifact"]["sha256"] = "0" * 64
            tampered_receipt.write_text(
                json.dumps(tampered_payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            tampered = self._run(
                tampered_receipt,
                artifact,
                provenance,
                dependencies,
                handoff,
                fresh,
                check=False,
            )
            self.assertNotEqual(tampered.returncode, 0)
            self.assertEqual(tampered.stdout, "")


if __name__ == "__main__":
    unittest.main()
