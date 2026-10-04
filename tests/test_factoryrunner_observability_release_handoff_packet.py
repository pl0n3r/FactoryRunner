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
BUILDER = ROOT / "scripts" / "create-observability-release-handoff-packet.ts"
PREFLIGHT_TEST = ROOT / "tests" / "test_factoryrunner_observability_release_candidate_preflight.py"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def load_preflight_fixture():
    spec = importlib.util.spec_from_file_location("_release_candidate_fixture", PREFLIGHT_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("No se pudo cargar fixture de preflight.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture_type = module.FactoryRunnerObservabilityReleaseCandidatePreflightTests
    return fixture_type(methodName="test_preflight_accepts_only_verified_receipt_bound_to_exact_main_source")


class FactoryRunnerObservabilityReleaseHandoffPacketTests(unittest.TestCase):
    def _evidence(self, root: Path) -> tuple[Path, Path, Path, Path]:
        fixture = load_preflight_fixture()
        receipt, snapshot, binding = fixture._write(root)
        preflight_run = fixture._run(receipt, snapshot, binding)
        preflight = root / "preflight.json"
        preflight.write_text(preflight_run.stdout, encoding="utf-8")
        return receipt, snapshot, binding, preflight

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
            receipt, snapshot, binding, preflight = self._evidence(root)
            first = root / "handoff-a.json"
            second = root / "handoff-b.json"
            self._run(receipt, snapshot, binding, preflight, first)
            self._run(receipt, snapshot, binding, preflight, second)

            first_body = first.read_bytes()
            self.assertEqual(first_body, second.read_bytes())
            packet = json.loads(first_body)
            verified = json.loads(preflight.read_text(encoding="utf-8"))
            self.assertEqual(first_body.decode("utf-8"), canonical(packet))
            self.assertLessEqual(len(first_body), 4096)
            self.assertEqual(packet["schema_version"], 1)
            self.assertEqual(packet["package"], verified["package"])
            self.assertEqual(packet["repository"], verified["repository"])
            for key in (
                "artifact_sha256",
                "receipt_sha256",
                "source_snapshot_sha256",
                "source_sha256",
                "binding_sha256",
            ):
                self.assertEqual(packet["evidence"][key], verified["evidence"][key])
            self.assertEqual(
                packet["evidence"]["preflight_sha256"],
                hashlib.sha256(preflight.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                packet["verification"],
                {"exact_main": True, "release_candidate_accepted": True},
            )

    def test_packet_is_bounded_secret_free_and_carries_no_publish_authority(self) -> None:
        source = BUILDER.read_text(encoding="utf-8").lower()
        self.assertIn("check-observability-release-candidate-preflight.ts", source)
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
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight = self._evidence(root)
            output = root / "handoff.json"
            self._run(receipt, snapshot, binding, preflight, output)
            packet = json.loads(output.read_text(encoding="utf-8"))

            self.assertEqual(packet["authority"], "unchanged")
            self.assertIs(packet["decision_required"], True)
            self.assertIs(packet["publish_authority"], False)
            self.assertIs(packet["network_access"], False)
            self.assertIs(packet["external_mutation"], False)
            lowered = output.read_text(encoding="utf-8").lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("handoff-secret-user-4ac731", lowered)

            exists = self._run(receipt, snapshot, binding, preflight, output, check=False)
            self.assertNotEqual(exists.returncode, 0)

            stale = json.loads(preflight.read_text(encoding="utf-8"))
            stale["repository"]["commit_sha"] = "7" * 40
            preflight.write_text(
                json.dumps(stale, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            stale_output = root / "stale.json"
            rejected = self._run(
                receipt,
                snapshot,
                binding,
                preflight,
                stale_output,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(stale_output.exists())

            mixed_root = root / "mixed"
            mixed_root.mkdir()
            receipt, snapshot, binding, preflight = self._evidence(mixed_root)
            binding_value = json.loads(binding.read_text(encoding="utf-8"))
            binding_value["unexpected"] = True
            binding.write_text(canonical(binding_value), encoding="utf-8")
            mixed_output = root / "mixed.json"
            rejected = self._run(
                receipt,
                snapshot,
                binding,
                preflight,
                mixed_output,
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse(mixed_output.exists())


if __name__ == "__main__":
    unittest.main()
