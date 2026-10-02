"""Aceptación ejecutable de readiness agregado FactoryRunner #78."""
from __future__ import annotations

import json
import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(script: str) -> dict[str, object]:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            textwrap.dedent(script),
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
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(output) from exc


FIXTURES = r"""
import { readinessSnapshot } from './src/readiness-snapshot.ts';
import { telemetryEnvelope } from './src/telemetry.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';

const adapters = [
  { id: 'browser-execution', capabilities: ['browser.navigate'] },
  { id: 'git-read', capabilities: ['git.head'] },
];

const identity = {
  version: 1,
  runner_id: runnerId,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['git.head', 'browser.navigate'],
  max_parallel: 4,
};

const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:78',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1500,
  instruction_ref: 'controlbot:instruction:factoryrunner-78',
};

const heartbeat = {
  version: 1,
  runner_id: runnerId,
  sequence: 10,
  observed_at: 1200,
  status: 'busy',
  capacity: { max: 4, active: 1 },
  active_sessions: ['controlbot:session:one'],
};

const queue = {
  version: 1,
  runner_id: runnerId,
  observed_at: 1200,
  queued_orders: 2,
};

const protocol = {
  version: 1,
  control_plane: 'controlbot',
  execution_plane: 'factoryrunner',
  protocol_version: 1,
  client_contract_version: 1,
  runner_id: runnerId,
  capabilities: ['browser.navigate', 'git.head'],
  freshness: 'fresh',
  authority: 'unchanged',
};

const telemetry = telemetryEnvelope(
  identity,
  adapters,
  order,
  heartbeat,
  queue,
  1215,
  30,
  { state: 'busy', degraded: false },
);

const runtimeState = {
  version: 1,
  runner_id: runnerId,
  observed_at: 1200,
  status: 'busy',
  freshness: 'fresh',
  authority: 'unchanged',
};
"""


class FactoryRunnerReadinessSnapshotTests(unittest.TestCase):
    def test_readiness_composes_identity_manifest_resources_telemetry_and_runtime_state(self):
        observed = run_node(
            FIXTURES
            + r"""
            const actual = readinessSnapshot(
              identity,
              adapters,
              protocol,
              heartbeat,
              queue,
              telemetry,
              runtimeState,
              1215,
              30,
            );
            console.log(JSON.stringify(actual));
            """
        )
        self.assertEqual(observed["status"], "READY")
        self.assertTrue(observed["ready"])
        self.assertEqual(observed["authority"], "unchanged")
        self.assertEqual(observed["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(observed["observed_at"], 1200)
        self.assertEqual(observed["runtime_status"], "busy")
        self.assertEqual(observed["reasons"], ["readiness_evidence_coherent"])
        for key in (
            "protocol_fingerprint",
            "manifest_fingerprint",
            "resource_fingerprint",
            "telemetry_fingerprint",
            "fingerprint",
        ):
            self.assertRegex(str(observed[key]), r"^[0-9a-f]{64}$")

    def test_stale_unknown_or_incoherent_evidence_never_reports_ready(self):
        observed = run_node(
            FIXTURES
            + r"""
            const cases = [
              readinessSnapshot(
                identity,
                adapters,
                { ...protocol, freshness: 'unknown' },
                heartbeat,
                queue,
                telemetry,
                runtimeState,
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                { ...heartbeat, observed_at: 1100 },
                { ...queue, observed_at: 1100 },
                telemetry,
                { ...runtimeState, observed_at: 1100 },
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                heartbeat,
                queue,
                telemetry,
                { ...runtimeState, freshness: 'unknown' },
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                heartbeat,
                queue,
                telemetry,
                { ...runtimeState, status: 'draining' },
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                heartbeat,
                queue,
                { ...telemetry, resource_fingerprint: 'f'.repeat(64) },
                runtimeState,
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                heartbeat,
                queue,
                telemetry,
                {
                  ...runtimeState,
                  runner_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                },
                1215,
                30,
              ),
              readinessSnapshot(
                identity,
                adapters,
                protocol,
                heartbeat,
                queue,
                telemetry,
                { ...runtimeState, observed_at: 1199 },
                1215,
                30,
              ),
            ];
            console.log(JSON.stringify({ cases }));
            """
        )
        rows = observed["cases"]
        self.assertEqual(len(rows), 7)
        for row in rows:
            self.assertEqual(row["status"], "BLOCKED")
            self.assertFalse(row["ready"])
            self.assertEqual(row["authority"], "unchanged")
            self.assertTrue(row["reasons"])
            self.assertRegex(str(row["fingerprint"]), r"^[0-9a-f]{64}$")

        reason_sets = [set(row["reasons"]) for row in rows]
        self.assertTrue(
            any("protocol:protocol_contract_not_fresh" in reasons for reasons in reason_sets)
        )
        self.assertTrue(any("runtime_not_fresh" in reasons for reasons in reason_sets))
        self.assertTrue(any("runtime_status_mismatch" in reasons for reasons in reason_sets))
        self.assertTrue(any("runtime_runner_mismatch" in reasons for reasons in reason_sets))
        self.assertTrue(any("runtime_observation_mismatch" in reasons for reasons in reason_sets))
        self.assertGreaterEqual(
            sum("readiness_evidence_invalid" in reasons for reasons in reason_sets),
            2,
        )


if __name__ == "__main__":
    unittest.main()
