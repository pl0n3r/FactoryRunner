"""Aceptación ejecutable del slice FactoryRunner #18."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerControlBotClientTests(unittest.TestCase):
    def test_poll_envelope_contract(self):
        source = read("src/controlbot/client.ts")
        tests = read("tests/controlbot-client-contracts.test.ts")
        self.assertIn("capabilities: [...this.#identity.capabilities]", source)
        self.assertIn("integer(limit, 'limit', 1, 64)", source)
        self.assertIn("controlbotcursor:", source)
        self.assertIn("poll envelope is exact", tests)

    def test_poll_response_order_validation_contract(self):
        source = read("src/controlbot/client.ts")
        tests = read("tests/controlbot-client-contracts.test.ts")
        self.assertIn("parseExecutionOrder", source)
        self.assertIn("assertOrderExecutable", source)
        self.assertIn("assertIdempotentOrder", source)
        self.assertIn("const staged = new Map", source)
        self.assertIn("collapses identical duplicates", tests)

    def test_ack_contract(self):
        source = read("src/controlbot/client.ts")
        tests = read("tests/controlbot-client-contracts.test.ts")
        self.assertIn("#validatedOrders", source)
        self.assertIn("orderFingerprint(parsed)", source)
        self.assertIn("instruction_ref", tests)
        self.assertIn("fingerprint", tests)

    def test_event_publish_contract(self):
        source = read("src/controlbot/client.ts")
        tests = read("tests/controlbot-client-contracts.test.ts")
        self.assertIn("parseExecutionEvent", source)
        self.assertIn("lastSequence", source)
        self.assertIn("event.sequence <= previous", source)
        self.assertIn("monotonic batch sequence", tests)

    def test_heartbeat_and_error_contract(self):
        source = read("src/controlbot/client.ts")
        tests = read("tests/controlbot-client-contracts.test.ts")
        self.assertIn("assertHeartbeatMatchesIdentity", source)
        self.assertIn("controlbot_transport_failed", source)
        self.assertIn("provider.example", tests)
        self.assertIn("supersecret", tests)

    def test_node_suite_contract(self):
        package = json.loads(read("package.json"))
        version = json.loads(read("config/version.json"))
        self.assertEqual(version["version"], "0.1.4")
        self.assertIn("typecheck", package["scripts"])
        self.assertIn("node --experimental-strip-types --test", package["scripts"]["test"])
        self.assertIn("node --experimental-strip-types scripts/build.ts", package["scripts"]["build"])


if __name__ == "__main__":
    unittest.main()
