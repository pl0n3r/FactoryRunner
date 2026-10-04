import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts" / "check-observability-release-handoff-replay-guard.ts"
MAIN_PIN_BUILDER = ROOT / "scripts" / "create-observability-release-handoff-main-pin.ts"
VERIFY_TEST = ROOT / "tests" / "test_factoryrunner_observability_release_handoff_verify.py"


def canonical(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def load_verify_fixture():
    spec = importlib.util.spec_from_file_location("_handoff_verify_fixture", VERIFY_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("No se pudo cargar fixture del verifier de handoff.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture_type = module.FactoryRunnerObservabilityReleaseHandoffVerifyTests
    return fixture_type(
        methodName="test_verifier_accepts_only_exact_packet_and_bound_release_candidate_evidence"
    )


class FactoryRunnerObservabilityReleaseHandoffReplayGuardTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path, Path, Path, Path, Path]:
        fixture = load_verify_fixture()
        receipt, snapshot, binding, preflight, handoff = fixture._fixture(root)
        packet = json.loads(handoff.read_text(encoding="utf-8"))
        pin = root / "main-pin.json"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(MAIN_PIN_BUILDER),
                "--commit-sha",
                packet["repository"]["commit_sha"],
                "--tree-sha",
                packet["repository"]["tree_sha"],
                "--output",
                str(pin),
            ],
            cwd=ROOT,
            env={},
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            self.fail(
                f"{MAIN_PIN_BUILDER.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return receipt, snapshot, binding, preflight, handoff, pin

    def _run(
        self,
        receipt: Path,
        snapshot: Path,
        binding: Path,
        preflight: Path,
        handoff: Path,
        pin: Path,
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["USER"] = "replay-guard-secret-user-f0a91c"
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(GUARD),
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
                "--main-pin",
                str(pin),
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
                f"{GUARD.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_replay_guard_accepts_only_handoff_matching_current_main_pin(self) -> None:
        source = GUARD.read_text(encoding="utf-8").lower()
        self.assertIn("check-observability-release-handoff-packet.ts", source)
        self.assertIn("process.execpath", source)
        self.assertIn("lstat(verifier)", source)
        self.assertNotIn("process.env", source)
        self.assertNotIn("shell: true", source)
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "api.github.com",
            "github.com",
            "git fetch",
            "git pull",
            "git push",
            "npm publish",
            "curl ",
            "wget ",
        ):
            self.assertNotIn(forbidden, source)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff, pin = self._fixture(root)
            completed = self._run(receipt, snapshot, binding, preflight, handoff, pin)
            payload = json.loads(completed.stdout)
            packet = json.loads(handoff.read_text(encoding="utf-8"))

            self.assertEqual(
                completed.stdout,
                json.dumps(payload, separators=(",", ":")) + "\n",
            )
            self.assertLessEqual(len(completed.stdout.encode("utf-8")), 4096)
            self.assertIs(payload["verified"], True)
            self.assertIs(payload["fresh"], True)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["repository"], packet["repository"])
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["decision_required"], True)
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = completed.stdout.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("replay-guard-secret-user-f0a91c", lowered)

    def test_old_handoff_fails_closed_after_expected_main_moves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff, pin = self._fixture(root)

            moved = json.loads(pin.read_text(encoding="utf-8"))
            moved["repository"]["commit_sha"] = "8" * 40
            moved["repository"]["tree_sha"] = "9" * 40
            pin.write_text(canonical(moved), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            pin_value = json.loads(pin.read_text(encoding="utf-8"))
            packet = json.loads(handoff.read_text(encoding="utf-8"))
            pin_value["repository"]["commit_sha"] = packet["repository"]["commit_sha"]
            pin_value["repository"]["tree_sha"] = "7" * 40
            pin.write_text(canonical(pin_value), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            malformed = json.loads(pin.read_text(encoding="utf-8"))
            malformed["unexpected"] = True
            pin.write_text(canonical(malformed), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            unknown = json.loads(pin.read_text(encoding="utf-8"))
            unknown.pop("unexpected", None)
            unknown["repository"]["commit_sha"] = "0" * 40
            pin.write_text(canonical(unknown), encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")


if __name__ == "__main__":
    unittest.main()
