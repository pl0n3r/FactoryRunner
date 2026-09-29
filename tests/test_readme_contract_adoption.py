"""Regresiones locales de adopción de README Contract v1 para FactoryRunner."""
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

    def test_readme_has_contract_v1_anatomy(self):
        readme = self.readme()
        for heading in REQUIRED_SECTIONS:
            self.assertEqual(readme.count(f"## {heading}"), 1, heading)
        self.assertTrue(readme.startswith("# FactoryRunner\n"))

    def test_derived_blocks_fail_closed_without_evidence(self):
        readme = self.readme()
        self.assertEqual(readme.count("<!-- factory:status:start -->"), 1)
        self.assertEqual(readme.count("<!-- factory:status:end -->"), 1)
        self.assertEqual(readme.count("<!-- factory:progress-readiness:start -->"), 1)
        self.assertEqual(readme.count("<!-- factory:progress-readiness:end -->"), 1)

        status = readme.split("<!-- factory:status:start -->", 1)[1].split(
            "<!-- factory:status:end -->", 1
        )[0]
        for label in (
            "main SHA",
            "versión",
            "CI",
            "release",
            "health",
            "smoke/observer",
            "quality/security",
            "Issue activo",
            "PR activo",
            "último release",
        ):
            self.assertIn(f"| {label} | UNKNOWN |", status)
        self.assertNotIn("| CI | GREEN |", status)
        self.assertNotIn("| health | GREEN |", status)
        self.assertNotIn("| smoke/observer | GREEN |", status)
        self.assertNotIn("| quality/security | GREEN |", status)

        progress = readme.split(
            "<!-- factory:progress-readiness:start -->", 1
        )[1].split("<!-- factory:progress-readiness:end -->", 1)[0]
        self.assertIn("| Target | UNKNOWN |", progress)
        self.assertIn("| Progress | UNKNOWN |", progress)
        self.assertIn("| Readiness | UNKNOWN |", progress)

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
