"""Aceptación ejecutable del slice FactoryRunner #11."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerOrderEventTests(unittest.TestCase):
    def test_execution_order_contract(self):
        source = read("src/order.ts")
        tests = read("tests/order-event-contracts.test.ts")
        self.assertIn("parseExecutionOrder", source)
        self.assertIn("TTL de orden excesivo", source)
        self.assertIn("instruction_ref debe ser opaca", source)
        self.assertIn("extra: true", tests)
        self.assertIn("token=supersecretvalue", tests)

    def test_order_runner_binding_contract(self):
        source = read("src/order.ts")
        tests = read("tests/order-event-contracts.test.ts")
        self.assertIn("assertOrderExecutable", source)
        self.assertIn("identity.capabilities.includes", source)
        self.assertIn("Orden pertenece a otro runner", source)
        self.assertIn("2_000", tests)

    def test_order_idempotency_contract(self):
        source = read("src/order.ts")
        validation = read("src/validation.ts")
        tests = read("tests/order-event-contracts.test.ts")
        self.assertIn("stableSha256", validation)
        self.assertIn("orderFingerprint", source)
        self.assertIn("Reuso conflictivo de order_id", source)
        self.assertIn("order fingerprint is stable", tests)

    def test_execution_event_contract(self):
        source = read("src/event.ts")
        tests = read("tests/order-event-contracts.test.ts")
        self.assertIn("parseExecutionEvent", source)
        self.assertIn("noSensitiveText", source)
        self.assertIn("parsed.hostname !== 'github.com'", source)
        self.assertIn("FactoryRunner/../private", tests)

    def test_event_transition_contract(self):
        source = read("src/event.ts")
        tests = read("tests/order-event-contracts.test.ts")
        self.assertIn("assertInitialEventMatchesOrder", source)
        self.assertIn("assertEventTransition", source)
        self.assertIn("Primer evento inválido", source)
        self.assertIn("Transición inválida", source)
        self.assertIn("initial event and transitions", tests)

    def test_node_suite_contract(self):
        package = json.loads(read("package.json"))
        version = json.loads(read("config/version.json"))
        self.assertRegex(version["version"], r"^0\.1\.[0-9]+$")
        self.assertIn("node --experimental-strip-types --test", package["scripts"]["test"])
        self.assertIn("node --experimental-strip-types scripts/build.ts", package["scripts"]["build"])
        self.assertTrue((ROOT / "tests" / "order-event-contracts.test.ts").is_file())


if __name__ == "__main__":
    unittest.main()
