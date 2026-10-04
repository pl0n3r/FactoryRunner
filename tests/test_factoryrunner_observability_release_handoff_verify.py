import hashlib
import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "check-observability-release-handoff-packet.ts"
PACKET_TEST = ROOT / "tests" / "test_factoryrunner_observability_release_handoff_packet.py"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def load_packet_fixture():
    spec = importlib.util.spec_from_file_location("_release_handoff_fixture", PACKET_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("No se pudo cargar fixture de handoff.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture_type = module.FactoryRunnerObservabilityReleaseHandoffPacketTests
    return fixture_type(
        methodName="test_packet_binds_preflight_receipt_source_and_exact_main_identity_deterministically"
    )


class FactoryRunnerObservabilityReleaseHandoffVerifyTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, Path, Path, Path]:
        fixture = load_packet_fixture()
        receipt, snapshot, binding, preflight = fixture._evidence(root)
        handoff = root / "handoff.json"
        fixture._run(receipt, snapshot, binding, preflight, handoff)
        return receipt, snapshot, binding, preflight, handoff

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
        env["USER"] = "handoff-verify-secret-user-31bf0f"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(VERIFIER),
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
                f"{VERIFIER.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_verifier_accepts_only_exact_packet_and_bound_release_candidate_evidence(
        self,
    ) -> None:
        source = VERIFIER.read_text(encoding="utf-8").lower()
        self.assertIn("create-observability-release-handoff-packet.ts", source)
        self.assertIn("process.execpath", source)
        self.assertNotIn("shell: true", source)
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "npm publish",
            "npm login",
            "git push",
            "curl ",
            "wget ",
            "registry.npmjs.org",
            "api.github.com",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff = self._fixture(root)
            completed = self._run(receipt, snapshot, binding, preflight, handoff)
            payload = json.loads(completed.stdout)
            packet = json.loads(handoff.read_text(encoding="utf-8"))

            self.assertEqual(
                completed.stdout,
                json.dumps(payload, separators=(",", ":")) + "\n",
            )
            self.assertLessEqual(len(completed.stdout.encode("utf-8")), 4096)
            self.assertIs(payload["verified"], True)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(
                payload["handoff_sha256"],
                hashlib.sha256(handoff.read_bytes()).hexdigest(),
            )
            self.assertEqual(payload["package"], packet["package"])
            self.assertEqual(payload["repository"], packet["repository"])
            self.assertEqual(payload["evidence"], packet["evidence"])
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["decision_required"], True)
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = completed.stdout.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("handoff-verify-secret-user-31bf0f", lowered)

    def test_tampered_mixed_stale_or_unknown_handoff_fails_closed_without_network(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            tampered_root = root / "tampered"
            tampered_root.mkdir()
            receipt, snapshot, binding, preflight, handoff = self._fixture(tampered_root)
            tampered = json.loads(handoff.read_text(encoding="utf-8"))
            tampered["evidence"]["artifact_sha256"] = "f" * 64
            handoff.write_text(canonical(tampered), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            mixed_root = root / "mixed"
            mixed_root.mkdir()
            receipt, snapshot, binding, preflight, handoff = self._fixture(mixed_root)
            mixed = json.loads(binding.read_text(encoding="utf-8"))
            mixed["source_snapshot"]["tree_sha"] = "9" * 40
            binding.write_text(canonical(mixed), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            stale_root = root / "stale"
            stale_root.mkdir()
            receipt, snapshot, binding, preflight, handoff = self._fixture(stale_root)
            stale = json.loads(preflight.read_text(encoding="utf-8"))
            stale["repository"]["commit_sha"] = "7" * 40
            preflight.write_text(
                json.dumps(stale, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            unknown_root = root / "unknown"
            unknown_root.mkdir()
            receipt, snapshot, binding, preflight, handoff = self._fixture(unknown_root)
            unknown = json.loads(handoff.read_text(encoding="utf-8"))
            unknown["schema_version"] = 2
            handoff.write_text(canonical(unknown), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            extra_root = root / "extra"
            extra_root.mkdir()
            receipt, snapshot, binding, preflight, handoff = self._fixture(extra_root)
            extra = json.loads(handoff.read_text(encoding="utf-8"))
            extra["unexpected"] = True
            handoff.write_text(canonical(extra), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")


if __name__ == "__main__":
    unittest.main()
