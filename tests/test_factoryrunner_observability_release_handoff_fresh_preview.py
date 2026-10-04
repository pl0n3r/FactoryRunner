import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / "scripts" / "check-observability-release-handoff-fresh-preview.ts"
REPLAY_TEST = ROOT / "tests" / "test_factoryrunner_observability_release_handoff_replay_guard.py"


def load_replay_fixture():
    spec = importlib.util.spec_from_file_location("_handoff_replay_fixture", REPLAY_TEST)
    if spec is None or spec.loader is None:
        raise RuntimeError("No se pudo cargar fixture del replay guard.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FactoryRunnerObservabilityReleaseHandoffReplayGuardTests(
        methodName="test_replay_guard_accepts_only_handoff_matching_current_main_pin"
    )


class FactoryRunnerObservabilityReleaseHandoffFreshPreviewTests(unittest.TestCase):
    def _fixture(self, root: Path):
        return load_replay_fixture()._fixture(root)

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
        env["USER"] = "fresh-preview-secret-user-9a47d2"
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
                f"{PREVIEW.name} failed with exit {completed.returncode}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return completed

    def test_fresh_preview_exposes_verified_identity_and_decision_required_only(self) -> None:
        source = PREVIEW.read_text(encoding="utf-8").lower()
        self.assertIn("check-observability-release-handoff-replay-guard.ts", source)
        self.assertIn("process.execpath", source)
        self.assertIn("lstat(guard)", source)
        self.assertNotIn("process.env", source)
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
            replay = json.loads(
                load_replay_fixture()._run(
                    receipt,
                    snapshot,
                    binding,
                    preflight,
                    handoff,
                    pin,
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
                    "verified",
                    "fresh",
                    "schema_version",
                    "handoff_sha256",
                    "repository",
                    "authority",
                    "decision_required",
                    "publish_authority",
                    "network_access",
                    "external_mutation",
                },
            )
            self.assertIs(payload["verified"], True)
            self.assertIs(payload["fresh"], True)
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["handoff_sha256"], replay["handoff_sha256"])
            self.assertEqual(payload["repository"], replay["repository"])
            self.assertEqual(payload["authority"], "unchanged")
            self.assertIs(payload["decision_required"], True)
            self.assertIs(payload["publish_authority"], False)
            self.assertIs(payload["network_access"], False)
            self.assertIs(payload["external_mutation"], False)

            lowered = completed.stdout.lower()
            self.assertNotIn(str(root).lower(), lowered)
            self.assertNotIn(socket.gethostname().lower(), lowered)
            self.assertNotIn("fresh-preview-secret-user-9a47d2", lowered)
            self.assertNotIn("package", lowered)
            self.assertNotIn("receipt_sha256", lowered)
            self.assertNotIn("source_sha256", lowered)
            self.assertNotIn("binding_sha256", lowered)
            self.assertNotIn("preflight_sha256", lowered)

    def test_stale_or_unverified_context_blocks_without_publish_network_or_external_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt, snapshot, binding, preflight, handoff, pin = self._fixture(root)

            stale = json.loads(pin.read_text(encoding="utf-8"))
            stale["repository"]["commit_sha"] = "8" * 40
            stale["repository"]["tree_sha"] = "9" * 40
            pin.write_text(json.dumps(stale, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

            second = root / "second"
            second.mkdir()
            receipt, snapshot, binding, preflight, handoff, pin = self._fixture(second)
            tampered = json.loads(handoff.read_text(encoding="utf-8"))
            tampered["decision_required"] = False
            handoff.write_text(
                json.dumps(tampered, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            rejected = self._run(
                receipt, snapshot, binding, preflight, handoff, pin, check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, "")

        source = PREVIEW.read_text(encoding="utf-8").lower()
        self.assertNotIn("publish_authority: true", source)
        self.assertNotIn("network_access: true", source)
        self.assertNotIn("external_mutation: true", source)


if __name__ == "__main__":
    unittest.main()
