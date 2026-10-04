import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / "scripts" / "check-observability-release-handoff-preview.ts"
VERIFY_TEST = ROOT / "tests" / "test_factoryrunner_observability_release_handoff_verify.py"


def load_verify_fixture():
    spec = importlib.util.spec_from_file_location("_handoff_verify_fixture", VERIFY_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("No se pudo cargar fixture de handoff verificado.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FactoryRunnerObservabilityReleaseHandoffVerifyTests(
        methodName="test_verifier_accepts_only_exact_packet_and_bound_release_candidate_evidence"
    )


class FactoryRunnerObservabilityReleaseHandoffPreviewTests(unittest.TestCase):
    def _fixture(self, root: Path):
        return load_verify_fixture()._fixture(root)

    def _run(
        self,
        receipt: Path,
        snapshot: Path,
        binding: Path,
        preflight: Path,
        handoff: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "handoff-preview-secret-user-e35b26"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(PREVIEW),
                "--handoff",
                str(handoff),
                "--verified-receipt",
                str(receipt),
                "--source-snapshot",
                str(snapshot),
                "--binding",
                str(binding),
                "--preflight",
                str(preflight),
            ],
            cwd=ROOT,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=45,
        )
        if check and completed.returncode != 0:
            self.fail(
                f"{PREVIEW.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_preview_exposes_only_verified_identity_fingerprints_and_human_decision_state(
        self,
    ) -> None:
        source = PREVIEW.read_text(encoding="utf-8").lower()
        self.assertIn("check-observability-release-handoff-packet.ts", source)
        self.assertIn("process.execpath", source)
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm publish",
            "npm login",
            "git push",
            "registry.npmjs.org",
            "api.github.com",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff = self._fixture(root)
            completed = self._run(receipt, snapshot, binding, preflight, handoff)
            payload = json.loads(completed.stdout)
            verified = json.loads(
                load_verify_fixture()._run(
                    receipt, snapshot, binding, preflight, handoff
                ).stdout
            )

            self.assertEqual(
                completed.stdout,
                json.dumps(payload, separators=(",", ":")) + "\n",
            )
            self.assertLessEqual(len(completed.stdout.encode("utf-8")), 2048)
            self.assertEqual(
                set(payload),
                {
                    "schema_version",
                    "package",
                    "repository",
                    "fingerprints",
                    "authority",
                    "decision_required",
                    "publish_authority",
                    "network_access",
                    "external_mutation",
                },
            )
            self.assertEqual(
                payload["package"],
                {
                    "name": verified["package"]["name"],
                    "version": verified["package"]["version"],
                },
            )
            self.assertEqual(payload["repository"], verified["repository"])
            self.assertEqual(
                payload["fingerprints"],
                {
                    "receipt_sha256": verified["evidence"]["receipt_sha256"],
                    "source_sha256": verified["evidence"]["source_sha256"],
                    "binding_sha256": verified["evidence"]["binding_sha256"],
                    "preflight_sha256": verified["evidence"]["preflight_sha256"],
                    "handoff_sha256": verified["handoff_sha256"],
                },
            )
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["decision_required"], True)
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = completed.stdout.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("handoff-preview-secret-user-e35b26", lowered)
            self.assertNotIn("artifact_sha256", lowered)
            self.assertNotIn("source_snapshot_sha256", lowered)

    def test_invalid_or_unverified_handoff_blocks_without_publish_network_or_external_mutation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff = self._fixture(root)

            tampered = json.loads(handoff.read_text(encoding="utf-8"))
            tampered["decision_required"] = False
            handoff.write_text(
                json.dumps(tampered, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            receipt, snapshot, binding, preflight, handoff = self._fixture(root / "mixed")
            mixed = json.loads(binding.read_text(encoding="utf-8"))
            mixed["source_snapshot"]["commit_sha"] = "8" * 40
            binding.write_text(
                json.dumps(mixed, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")


if __name__ == "__main__":
    unittest.main()
