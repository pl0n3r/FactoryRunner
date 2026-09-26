"""Criterios ejecutables de bootstrap; el comportamiento completo corre en npm test."""
from __future__ import annotations
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

class FactoryRunnerAcceptanceTests(unittest.TestCase):
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
        self.assertIn("release-version:", ci)
        self.assertIn("github.event.before", ci)
        self.assertIn('json.load(open("config/version.json"', ci)
        self.assertIn("needs.release-version.outputs.changed == 'true'", ci)
        self.assertIn("needs: [ci, release-version]", ci)
        self.assertIn("github.ref == 'refs/heads/main'", ci)
        self.assertIn("pl0n3r/factory/.github/workflows/release.yml@v1", ci)
        self.assertFalse((ROOT / ".github/workflows/release.yml").exists())

    def test_runner_identity_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/contracts.test.ts")
        self.assertIn("parseRunnerIdentity", source)
        self.assertIn("Capabilities duplicadas", source)
        self.assertIn("hostinger-shared", tests)
        self.assertIn("macos-local", tests)
        self.assertIn("rejects duplicates/extras", tests)

    def test_heartbeat_contract(self):
        source = read("src/runner.ts")
        tests = read("tests/contracts.test.ts")
        for value in ("healthy", "stale", "offline"):
            self.assertIn(value, source)
        self.assertIn("heartbeat health is deterministic and fail-closed", tests)
        self.assertIn("availableCapacity", source)

    def test_execution_order_contract(self):
        source = read("src/order.ts")
        tests = read("tests/contracts.test.ts")
        self.assertIn("assertIdempotentOrder", source)
        self.assertIn("instruction_ref debe ser opaca", source)
        self.assertIn("token: 'secret'", tests)
        self.assertIn("campos inválidos", tests)

    def test_execution_event_contract(self):
        source = read("src/event.ts")
        validation = read("src/validation.ts")
        tests = read("tests/contracts.test.ts")
        self.assertIn("TRANSITIONS", source)
        self.assertIn("assertEventTransition", source)
        self.assertIn("noSensitiveText", source)
        self.assertIn("token=supersecret", tests)
        self.assertIn("github_pat_", validation)
        self.assertIn("gho_", validation)
        self.assertIn("github_pat_abcdefghijklmnopqrstuvwxyz123456", tests)
        self.assertIn("gho_abcdefghijklmnopqrstuvwxyz123456", tests)

    def test_node_suite_contract(self):
        package = json.loads(read("package.json"))
        lock = json.loads(read("package-lock.json"))
        self.assertEqual(lock["lockfileVersion"], 3)
        self.assertEqual(lock["packages"][""]["engines"]["node"], ">=24")
        self.assertNotIn("dependencies", package)
        self.assertNotIn("devDependencies", package)
        self.assertTrue((ROOT / "scripts/build.ts").is_file())

    def test_privacy_documents_are_generated_construction_drafts(self):
        expected = {
            "politica-tratamiento.md",
            "aviso-privacidad.md",
            "terminos-condiciones.md",
            "registro-tratamientos.md",
            "canal-derechos.md",
            "retencion.md",
        }
        root = ROOT / "docs" / "privacidad"
        self.assertEqual({path.name for path in root.glob("*.md")}, expected)
        combined = "\n".join(read(f"docs/privacidad/{name}") for name in sorted(expected))
        self.assertIn("pl0n3r/FactoryRunner", combined)
        self.assertIn("[COMPLETAR POR EL DUEÑO]", combined)
        self.assertIn("revisión jurídica requerida", combined)
        self.assertIn("runner_location_metadata", combined)
        self.assertNotIn("consentimiento otorgado", combined)

        datos = json.loads(read("datos.yml"))
        self.assertEqual(datos["phase"], "construccion")
        self.assertEqual(len(datos["treatments"]), 1)
        treatment = datos["treatments"][0]
        self.assertEqual(treatment["id"], "runner_location_metadata")
        self.assertEqual(treatment["category"], "location")
        self.assertEqual(treatment["fields"], ["location"])
        self.assertEqual(treatment["basis"], "review_required")
        self.assertEqual(treatment["retention"], "review_required")
        self.assertEqual(treatment["consent"], "review_required")
        self.assertEqual(treatment["providers"], [])

if __name__ == "__main__":
    unittest.main()
