"""Aceptación ejecutable de compatibilidad de protocolo FactoryRunner #77."""
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


class FactoryRunnerProtocolCompatibilityTests(unittest.TestCase):
    def test_supported_protocol_identity_and_client_contract_are_compatible(self):
        observed = run_node(
            """
            import { protocolCompatibility } from './src/protocol-compatibility.ts';

            const identity = {
              version: 1,
              runner_id: '11111111-2222-4333-8444-555555555555',
              protocol_version: 1,
              runtime: 'node',
              runtime_version: '24.0.0',
              platform: 'hostinger',
              location: 'shared-web-hosting',
              capabilities: ['git-read', 'programmatic'],
              max_parallel: 2,
            };
            const contract = {
              version: 1,
              control_plane: 'controlbot',
              execution_plane: 'factoryrunner',
              protocol_version: 1,
              client_contract_version: 1,
              runner_id: identity.runner_id,
              capabilities: ['programmatic', 'git-read'],
              freshness: 'fresh',
              authority: 'unchanged',
            };

            console.log(JSON.stringify(protocolCompatibility(identity, contract)));
            """
        )
        self.assertEqual(observed["status"], "READY")
        self.assertTrue(observed["compatible"])
        self.assertEqual(observed["authority"], "unchanged")
        self.assertEqual(observed["protocol_version"], 1)
        self.assertEqual(observed["client_contract_version"], 1)
        self.assertEqual(observed["reasons"], ["protocol_compatible"])
        self.assertRegex(str(observed["fingerprint"]), r"^[0-9a-f]{64}$")

    def test_unknown_downgrade_or_contradictory_protocol_fails_closed(self):
        observed = run_node(
            """
            import { protocolCompatibility } from './src/protocol-compatibility.ts';

            const identity = {
              version: 1,
              runner_id: '11111111-2222-4333-8444-555555555555',
              protocol_version: 1,
              runtime: 'node',
              runtime_version: '24.0.0',
              platform: 'hostinger',
              location: 'shared-web-hosting',
              capabilities: ['git-read', 'programmatic'],
              max_parallel: 2,
            };
            const base = {
              version: 1,
              control_plane: 'controlbot',
              execution_plane: 'factoryrunner',
              protocol_version: 1,
              client_contract_version: 1,
              runner_id: identity.runner_id,
              capabilities: ['git-read', 'programmatic'],
              freshness: 'fresh',
              authority: 'unchanged',
            };
            const cases = [
              { ...base, freshness: 'unknown' },
              { ...base, freshness: 'stale' },
              { ...base, protocol_version: 0 },
              { ...base, protocol_version: 2 },
              { ...base, client_contract_version: 0 },
              { ...base, client_contract_version: 2 },
              { ...base, runner_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
              { ...base, capabilities: ['git-read'] },
              { ...base, control_plane: 'factoryrunner' },
              { ...base, authority: 'expanded' },
              { ...base, unexpected: true },
            ];
            const results = cases.map((candidate) =>
              protocolCompatibility(identity, candidate)
            );
            const invalidIdentity = protocolCompatibility(
              { ...identity, protocol_version: 2 },
              base,
            );
            console.log(JSON.stringify({ results, invalidIdentity }));
            """
        )
        rows = observed["results"]
        self.assertEqual(len(rows), 11)
        for row in rows:
            self.assertEqual(row["status"], "BLOCKED")
            self.assertFalse(row["compatible"])
            self.assertEqual(row["authority"], "unchanged")
            self.assertTrue(row["reasons"])
            self.assertRegex(str(row["fingerprint"]), r"^[0-9a-f]{64}$")

        reasons = {row["reasons"][0] for row in rows}
        self.assertIn("protocol_contract_not_fresh", reasons)
        self.assertIn("protocol_downgrade", reasons)
        self.assertIn("protocol_version_unsupported", reasons)
        self.assertIn("client_contract_downgrade", reasons)
        self.assertIn("runner_identity_contradiction", reasons)
        self.assertIn("capability_contract_contradiction", reasons)
        self.assertIn("controlbot_contract_invalid", reasons)

        invalid_identity = observed["invalidIdentity"]
        self.assertEqual(invalid_identity["status"], "BLOCKED")
        self.assertEqual(invalid_identity["authority"], "unchanged")
        self.assertEqual(invalid_identity["reasons"], ["runner_identity_invalid"])


if __name__ == "__main__":
    unittest.main()
