"""Aceptación ejecutable del doctor offline FactoryRunner #79."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "offline-doctor.ts"


class FactoryRunnerOfflineDoctorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { offlineDoctor } from './src/offline-doctor.ts';
        import { stableSha256 } from './src/validation.ts';

        const readyCore = {
          version: 1,
          status: 'READY',
          ready: true,
          authority: 'unchanged',
          runner_id: '11111111-1111-7111-8111-111111111111',
          observed_at: 1200,
          runtime_status: 'busy',
          protocol_fingerprint: 'a'.repeat(64),
          manifest_fingerprint: 'b'.repeat(64),
          resource_fingerprint: 'c'.repeat(64),
          telemetry_fingerprint: 'd'.repeat(64),
          reasons: ['readiness_evidence_coherent'],
        };
        const ready = { ...readyCore, fingerprint: stableSha256(readyCore) };

        const blockedCore = {
          ...readyCore,
          status: 'BLOCKED',
          ready: false,
          runtime_status: 'unknown',
          resource_fingerprint: null,
          reasons: ['runtime_not_fresh'],
        };
        const blocked = { ...blockedCore, fingerprint: stableSha256(blockedCore) };

        const secretCore = {
          ...readyCore,
          reasons: ['token=supersecretvalue'],
        };
        const secretBearing = { ...secretCore, fingerprint: stableSha256(secretCore) };

        const passOne = offlineDoctor(ready);
        const passTwo = offlineDoctor(ready);
        const blockedReport = offlineDoctor(blocked);
        const secretReport = offlineDoctor(secretBearing);

        console.log(JSON.stringify({
          passOne,
          passTwo,
          blockedReport,
          secretReport,
        }));
        """
        output = subprocess.check_output(
            (
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "-e",
                script,
            ),
            cwd=ROOT,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=20,
        )
        cls.observed = json.loads(output)

    def test_doctor_emits_deterministic_secret_free_diagnostics_from_local_snapshot(self):
        first = self.observed["passOne"]
        second = self.observed["passTwo"]
        secret = self.observed["secretReport"]

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "PASS")
        self.assertEqual(first["authority"], "unchanged")
        self.assertEqual(first["source"]["readiness_status"], "READY")
        self.assertEqual(first["source"]["runtime_status"], "busy")
        self.assertEqual(
            [item["status"] for item in first["diagnostics"]],
            ["PASS", "PASS", "PASS", "PASS"],
        )
        self.assertRegex(first["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertNotIn("reasons", json.dumps(first))
        self.assertNotIn("supersecretvalue", json.dumps(secret))
        self.assertEqual(secret["status"], "BLOCKED")
        self.assertEqual(secret["source"]["readiness_status"], "UNKNOWN")

    def test_doctor_performs_no_network_provider_or_external_mutation(self):
        report = self.observed["blockedReport"]
        self.assertEqual(report["status"], "BLOCKED")
        self.assertFalse(report["network_access"])
        self.assertFalse(report["provider_access"])
        self.assertFalse(report["external_mutation"])
        self.assertEqual(report["authority"], "unchanged")

        source = SOURCE.read_text(encoding="utf-8")
        forbidden = (
            "node:http",
            "node:https",
            "child_process",
            "fetch(",
            "XMLHttpRequest",
            "process.env",
            "writeFile",
            "appendFile",
            "unlink(",
            "ControlBotClient",
        )
        for token in forbidden:
            self.assertNotIn(token, source)


if __name__ == "__main__":
    unittest.main()
