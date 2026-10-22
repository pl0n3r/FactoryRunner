"""Regresiones de adopción de README Contract v2 para FactoryRunner."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
METADATA = ROOT / "readme" / "project.json"
WORKFLOW = ROOT / ".github" / "workflows" / "readme-contract.yml"

REQUIRED_METADATA = {"name", "tagline", "role", "phase", "roadmap", "stack"}
FORBIDDEN_OPERATIONAL = {
    "main_sha",
    "version",
    "ci",
    "release",
    "health",
    "smoke",
    "quality",
    "active_issue",
    "active_pr",
    "last_release",
}
REQUIRED_SECTIONS = (
    "Operational Cockpit",
    "Work Queue",
    "Qué hace el producto",
    "Arquitectura en 60 segundos",
    "Stack e infraestructura",
    "Ciclo de entrega",
    "Calidad y seguridad",
    "Roadmap y fuentes de verdad",
    "Desarrollo local",
    "Mapa de la fábrica",
)


class ReadmeContractAdoptionTests(unittest.TestCase):
    def readme(self) -> str:
        return README.read_text(encoding="utf-8")

    def test_project_metadata_is_stable_and_complete(self):
        metadata = json.loads(METADATA.read_text(encoding="utf-8"))
        self.assertEqual(set(metadata), REQUIRED_METADATA)
        self.assertFalse(set(metadata) & FORBIDDEN_OPERATIONAL)
        for key in REQUIRED_METADATA:
            self.assertIsInstance(metadata[key], str)
            self.assertTrue(metadata[key].strip(), key)
        self.assertEqual(metadata["phase"], "construction")
        self.assertEqual(metadata["role"], "execution plane")

    def test_readme_is_contract_v2_without_unknown_blocks(self):
        readme = self.readme()
        self.assertTrue(readme.startswith("# FactoryRunner\n"))

        # Hero más diez secciones: once superficies v2 en orden, sin duplicados.
        offsets = [readme.index(f"## {h}") for h in REQUIRED_SECTIONS]
        self.assertEqual(offsets, sorted(offsets))
        for heading in REQUIRED_SECTIONS:
            self.assertEqual(readme.count(f"## {heading}"), 1, heading)

        for legacy in (
            "UNKNOWN", "factory:status", "factory:progress-readiness",
            "Progress + Readiness", "| main SHA |", "| Target |",
            "| Readiness |", "| Señal | Estado |",
        ):
            self.assertNotIn(legacy, readme, legacy)

        cockpit = readme.split("## Operational Cockpit", 1)[1].split("\n## ", 1)[0]
        self.assertIn("actions/workflows/ci.yml/badge.svg?branch=main", cockpit)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/actions", cockpit)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/releases", cockpit)
        self.assertIn("https://img.shields.io/github/v/release/pl0n3r/FactoryRunner", cockpit)
        self.assertIn("https://control.condorapp.com.co/", cockpit)
        self.assertIn("docs/local-observer.md", cockpit)
        self.assertIn("demo sintética local", cockpit)
        self.assertIn("sin commits de refresco", cockpit)
        self.assertNotIn("https://example.com", cockpit)

        # Sin falsos positivos de health/readiness o autorización live.
        self.assertIn("sin go-live", readme)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/431", readme)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/465", readme)

    def test_consumer_workflow_uses_factory_v1(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("uses: pl0n3r/factory/.github/workflows/readme.yml@v1", workflow)
        self.assertIn("readme_path: README.md", workflow)
        self.assertIn("metadata_path: readme/project.json", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)

    def test_work_queue_links_canonical_roadmap(self):
        readme = self.readme()
        queue = readme.split("## Work Queue", 1)[1].split("\n## ", 1)[0]
        for lane in ("NOW", "NEXT", "LATER", "BLOCKED"):
            self.assertIn(f"**{lane}:**", queue)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/20", queue)
        self.assertIn("https://github.com/pl0n3r/Factory/issues/168", queue)
        # La cola se resuelve con Issues ABIERTOS, no con hojas ya cerradas.
        self.assertIn("issues?q=is%3Aissue%20is%3Aopen", queue)
        for state in ("disponible", "planificado", "bloqueado"):
            self.assertIn(f"label%3A%22estado%3A%20{state}%22", queue)
        self.assertIn("https://github.com/pl0n3r/FactoryRunner/issues/465", queue)
        for closed_issue in (431, 585):
            self.assertNotIn(f"https://github.com/pl0n3r/FactoryRunner/issues/{closed_issue}", queue)

    def test_factory_map_preserves_roles(self):
        readme = self.readme()
        factory_map = readme.split("## Mapa de la fábrica", 1)[1]
        for expected in (
            "Factory** — governance/kit",
            "ControlBot** — control plane",
            "FactoryRunner** — execution plane",
            "Condor / GrindFlow / BRVTAL** — productos",
            "AutoFactory** — herramienta local/manual",
        ):
            self.assertIn(expected, factory_map)
        self.assertIn("AutoFactory no se migra ni se modifica desde FactoryRunner", factory_map)


if __name__ == "__main__":
    unittest.main()
