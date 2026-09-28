import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DECISIONS = ROOT / "decisiones.yml"
DATA_MAP = ROOT / "datos.yml"
PRIVACY_DIR = ROOT / "docs" / "privacidad"

REQUIRED_PRIVACY_DOCS = {
    "politica-tratamiento.md",
    "aviso-privacidad.md",
    "terminos-condiciones.md",
    "registro-tratamientos.md",
    "canal-derechos.md",
    "retencion.md",
}


class GovernanceBootstrapTests(unittest.TestCase):
    def _decisions(self) -> dict:
        return json.loads(DECISIONS.read_text(encoding="utf-8"))

    def test_decision_ids_follow_factory_contract(self) -> None:
        rows = self._decisions()["decisions"]
        ids = [row["id"] for row in rows]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(re.fullmatch(r"D-[0-9]{3,}", value) for value in ids))

    def test_runner_decisions_preserve_semantics(self) -> None:
        rows = {row["id"]: row for row in self._decisions()["decisions"]}
        expected = {
            "D-063": "ControlBot es el control plane; FactoryRunner es el execution plane; AutoFactory permanece independiente y no se modifica.",
            "D-064": "Target primario Hostinger Shared/Web Hosting; macOS local solo fallback si existe evidencia de incompatibilidad técnica.",
            "D-065": "FactoryRunner nunca recibe ni persiste secretos dentro de órdenes, logs o repositorio; solo referencias opacas y aliases.",
        }
        for decision_id, text in expected.items():
            self.assertEqual("active", rows[decision_id]["status"])
            self.assertEqual(text, rows[decision_id]["text"])

    def test_privacy_documents_cover_current_location_metadata(self) -> None:
        data = json.loads(DATA_MAP.read_text(encoding="utf-8"))
        self.assertEqual(1, len(data["treatments"]))
        treatment = data["treatments"][0]
        self.assertEqual("runner_location_metadata", treatment["id"])
        self.assertEqual("location", treatment["category"])
        self.assertEqual(["location"], treatment["fields"])
        self.assertEqual("runner_routing", treatment["purpose"])
        self.assertEqual("review_required", treatment["basis"])
        self.assertEqual("review_required", treatment["retention"])
        self.assertEqual("review_required", treatment["consent"])
        self.assertEqual([], treatment["providers"])
        self.assertEqual(
            REQUIRED_PRIVACY_DOCS,
            {path.name for path in PRIVACY_DIR.glob("*.md")},
        )
        self.assertIn(
            "| runner_location_metadata | location | location | runner_routing | review_required | review_required | ninguno_declarado | review_required |",
            (PRIVACY_DIR / "politica-tratamiento.md").read_text(encoding="utf-8"),
        )
        self.assertIn(
            "## runner_location_metadata",
            (PRIVACY_DIR / "registro-tratamientos.md").read_text(encoding="utf-8"),
        )
        self.assertIn(
            "| runner_location_metadata | location | review_required | review_required |",
            (PRIVACY_DIR / "retencion.md").read_text(encoding="utf-8"),
        )

    def test_callers_keep_policy_and_privacy_factory_v1(self) -> None:
        policy = (ROOT / ".github" / "workflows" / "politica.yml").read_text(encoding="utf-8")
        privacy = (ROOT / ".github" / "workflows" / "privacidad.yml").read_text(encoding="utf-8")
        self.assertIn("uses: pl0n3r/factory/.github/workflows/politica.yml@v1", policy)
        self.assertIn("uses: pl0n3r/factory/.github/workflows/privacidad.yml@v1", privacy)
        self.assertIn("kit_ref: v1", privacy)

    def test_bootstrap_scope_minimizes_runtime_metadata(self) -> None:
        data = json.loads(DATA_MAP.read_text(encoding="utf-8"))
        self.assertEqual("pl0n3r/FactoryRunner", data["project"])
        self.assertEqual("construccion", data["phase"])
        self.assertEqual(["runner_location_metadata"], [row["id"] for row in data["treatments"]])
        self.assertEqual([], data["treatments"][0]["providers"])
        for path in PRIVACY_DIR.glob("*.md"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("password", text.lower())
            self.assertNotIn("token", text.lower())


if __name__ == "__main__":
    unittest.main()
