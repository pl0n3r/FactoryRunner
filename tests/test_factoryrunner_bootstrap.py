"""Aceptación ejecutable del slice FactoryRunner #9."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerBootstrapTests(unittest.TestCase):
    def test_node_factory_bootstrap_contract(self):
        package = json.loads(read("package.json"))
        self.assertEqual(package["engines"]["node"], ">=24")
        self.assertEqual(package["type"], "module")
        self.assertIn("node --experimental-strip-types --test", package["scripts"]["test"])
        self.assertIn("node --experimental-strip-types scripts/build.ts", package["scripts"]["build"])
        ci = read(".github/workflows/ci.yml")
        self.assertIn("pl0n3r/factory/.github/workflows/ci.yml@v1", ci)
        self.assertIn("stack: node", ci)
        self.assertIn("node_enabled: true", ci)
        self.assertIn("node_version: '24'", ci)
        self.assertIn("node-main:", ci)
        self.assertIn("npm test", ci)
        self.assertIn("npm run build", ci)
        self.assertIn("needs: [ci, node-main, release-version]", ci)

    def test_runner_identity_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/runner-contracts.test.ts")
        self.assertIn("parseRunnerIdentity", source)
        self.assertIn("Capabilities duplicadas", source)
        self.assertIn("hostinger-shared", tests)
        self.assertIn("macos-local", tests)
        self.assertIn("campos inválidos", tests)

    def test_runner_heartbeat_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/runner-contracts.test.ts")
        self.assertIn("parseRunnerHeartbeat", source)
        self.assertIn("active_sessions inconsistentes", source)
        self.assertIn("Estado de heartbeat inválido", source)
        self.assertIn("capacity.active inválido", tests)

    def test_heartbeat_health_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/runner-contracts.test.ts")
        for state in ("healthy", "stale", "offline"):
            self.assertIn(state, source)
        self.assertIn("heartbeat health is deterministic and fail-closed", tests)
        self.assertIn("heartbeatHealth(parsed, 900)", tests)

    def test_available_capacity_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/runner-contracts.test.ts")
        self.assertIn("availableCapacity", source)
        self.assertIn("heartbeat.status === 'draining'", source)
        self.assertIn("available capacity is bounded", tests)
        self.assertIn("assertHeartbeatMatchesIdentity(identity, heartbeat)", source)
        self.assertIn("max_parallel: 1", tests)

    def test_node_suite_contract(self):
        package = json.loads(read("package.json"))
        lock = json.loads(read("package-lock.json"))
        self.assertEqual(lock["lockfileVersion"], 3)
        self.assertEqual(lock["packages"][""]["engines"]["node"], ">=24")
        self.assertNotIn("dependencies", package)
        self.assertNotIn("devDependencies", package)
        self.assertTrue((ROOT / "scripts/build.ts").is_file())


if __name__ == "__main__":
    unittest.main()
