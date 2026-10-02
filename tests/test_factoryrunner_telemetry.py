"""Aceptación ejecutable de TelemetryEnvelope FactoryRunner #66."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE_TEST = ROOT / "tests" / "telemetry.test.ts"


def run_node_test(name: str) -> str:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--test",
            f"--test-name-pattern={name}",
            str(NODE_TEST),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise AssertionError(output)
    return output


class FactoryRunnerTelemetryTests(unittest.TestCase):
    def test_telemetry_links_runner_order_observation_and_manifest_without_raw_secret_material(self):
        output = run_node_test(
            "TelemetryEnvelope links runner order observation and manifest without raw secret material"
        )
        self.assertIn(
            "TelemetryEnvelope links runner order observation and manifest without raw secret material",
            output,
        )
        self.assertIn("pass 1", output)

    def test_secret_like_or_oversized_telemetry_payload_fails_closed(self):
        output = run_node_test(
            "TelemetryEnvelope fails closed on secret-like or oversized payload"
        )
        self.assertIn(
            "TelemetryEnvelope fails closed on secret-like or oversized payload",
            output,
        )
        self.assertIn("pass 1", output)


if __name__ == "__main__":
    unittest.main()
