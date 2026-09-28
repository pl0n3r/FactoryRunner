"""Aceptación ejecutable del BrowserExecutionAdapter FactoryRunner #16."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerBrowserAdapterTests(unittest.TestCase):
    def test_browser_capability_contract(self):
        source = read("src/adapters/browser.ts")
        tests = read("tests/browser-adapter-contracts.test.ts")
        self.assertIn("BrowserExecutionAdapter", source)
        self.assertIn("browser.navigate", source)
        self.assertIn("browser.click_ref", source)
        self.assertIn("browser.type_ref", source)
        self.assertIn("browser.close", source)
        self.assertIn("selector: '#danger'", tests)
        self.assertNotIn("css_selector", source)
        self.assertNotIn("xpath", source.lower())

    def test_navigation_origin_contract(self):
        source = read("src/adapters/browser.ts")
        tests = read("tests/browser-adapter-contracts.test.ts")
        self.assertIn("parsed.protocol !== 'https:'", source)
        self.assertIn("!allowedOrigins.has(parsed.origin)", source)
        self.assertIn("parsed.search !== ''", source)
        self.assertIn("parsed.hash !== ''", source)
        self.assertIn("https://evil.example/path", tests)
        self.assertIn("%252e%252e", tests)

    def test_opaque_ref_and_type_contract(self):
        source = read("src/adapters/browser.ts")
        tests = read("tests/browser-adapter-contracts.test.ts")
        self.assertIn("OPAQUE_REF_RE", source)
        self.assertIn("noSensitiveText", source)
        self.assertIn("4_000", source)
        self.assertIn("token=supersecretvalue", tests)
        self.assertIn("session_key: 'attacker-session'", tests)

    def test_browser_evidence_privacy_contract(self):
        source = read("src/adapters/browser.ts")
        tests = read("tests/browser-adapter-contracts.test.ts")
        self.assertIn("exactKeys(record, ['status', 'ref']", source)
        self.assertIn("BrowserExecutionError", source)
        self.assertIn("<html>secret</html>", tests)
        for forbidden in ("cookies", "headers", "screenshot", "localStorage"):
            self.assertNotIn(forbidden, source)

    def test_location_portability_contract(self):
        source = read("src/adapters/browser.ts")
        tests = read("tests/browser-adapter-contracts.test.ts")
        self.assertIn("'hostinger-shared' | 'macos-local'", source)
        self.assertIn("hostinger-shared", tests)
        self.assertIn("macos-local", tests)
        self.assertIn("assert.deepEqual(hostinger.driver.commands, macos.driver.commands)", tests)

    def test_node_suite_contract(self):
        package = json.loads(read("package.json"))
        version = json.loads(read("config/version.json"))
        parts = tuple(int(piece) for piece in version["version"].split("."))
        self.assertGreaterEqual(parts, (0, 1, 3))
        self.assertIn("npm run typecheck", read(".github/workflows/ci.yml"))
        self.assertEqual(package["scripts"]["typecheck"], "tsc --noEmit")
        self.assertIn("node --experimental-strip-types --test", package["scripts"]["test"])
        self.assertIn("node --experimental-strip-types scripts/build.ts", package["scripts"]["build"])
        self.assertTrue((ROOT / "tests" / "browser-adapter-contracts.test.ts").is_file())


if __name__ == "__main__":
    unittest.main()
