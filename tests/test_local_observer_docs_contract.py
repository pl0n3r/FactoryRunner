"""Executable offline QA contract for FactoryRunner local observer docs (#490).

This contract reads only repository files. It does not connect to the Mac,
start HTTP servers, open sessions, load secrets or execute a runtime agent.
"""
from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = ROOT / "docs" / "local-observer.md"


class LocalObserverDocsContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.doc = DOC_PATH.read_text(encoding="utf-8")

    def test_docs_cover_all_current_observer_modules(self) -> None:
        paths = (
            "src/local-observer-snapshot.ts",
            "src/local-observer-html.ts",
            "src/local-observer-source-adapter.ts",
            "src/local-observer-runtime-projection.ts",
            "scripts/local-observer-server.ts",
        )
        for name in paths:
            with self.subTest(module=name):
                self.assertTrue((ROOT / name).is_file(), name)
                self.assertIn(name, self.doc)
        self.assertIn("kind=in_process_candidate", self.doc)
        self.assertIn("no están conectadas a una fuente de observación real", self.doc)
        self.assertIn("no se importa ni se sirve", self.doc)

    def test_rollback_requires_commit_aware_reverse_order(self) -> None:
        docs = self.doc
        self.assertIn("## Rollback seguro y dependencias", docs)
        self.assertIn("git revert", docs)
        self.assertIn("orden inverso de dependencias", docs)
        self.assertIn("commits de merge", docs)
        self.assertIn("CI exact-main", docs)
        self.assertIn("npm run typecheck", docs)
        self.assertIn("npm test", docs)
        self.assertNotIn("Revertir estos cuatro archivos", docs)
        self.assertNotIn("elimina íntegramente el prototipo", docs)
        for ref in ("#478", "#480", "#482", "#483", "#488"):
            self.assertIn(ref, docs)

    def test_go_live_431_owner_a_offline_only(self) -> None:
        """Closing the human gate grants offline preflight, never real go-live."""
        docs = self.doc
        self.assertIn("go-live #431 está CLOSED/completed", docs)
        self.assertIn("OWNER A, limitada a preflight offline reversible", docs)
        self.assertIn("La activación live sigue sin autorización", docs)
        self.assertIn("otra decisión explícita del dueño", docs)
        self.assertNotIn("go-live #431 está bloqueado", docs)

    def test_demo_remains_synthetic_and_not_deployed(self) -> None:
        docs = self.doc
        for phrase in (
            "NO LIVE",
            "synthetic_only",
            "readiness=UNKNOWN",
            "127.0.0.1",
            "capacity.available=null",
            "FRESH no autoriza READY ni live",
            "no están conectadas a una fuente de observación real",
            "--demo",
            "go-live #431",
        ):
            with self.subTest(claim=phrase):
                self.assertIn(phrase, docs)
        self.assertIn('"mode":"synthetic_only","readiness":"UNKNOWN"', docs)
        self.assertIn("no se importa ni se sirve", docs)


if __name__ == "__main__":
    unittest.main()
