"""Aceptación de FactoryRunner #600: inventario histórico y evidencia por fila."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "reconciliacion-issues-20261024.md"
ISSUE_LINK = re.compile(
    r"^\[#(?P<number>\d+)\]\(https://github\.com/pl0n3r/FactoryRunner/issues/(?P=number)\)$"
)
EVIDENCE_LINK = re.compile(
    r"\[[^\]]+\]\((https://github\.com/pl0n3r/FactoryRunner/"
    r"(?:issues|pull|actions/runs)/[^)\s]+)\)"
)


class ReconciliacionIssuesTests(unittest.TestCase):
    def test_acceptance(self) -> None:
        doc = DOC.read_text(encoding="utf-8")
        self.assertIn("main@789a312d7520e9813835f99d8c4e5de5ee22cb2a", doc)
        self.assertIn("PR efectivamente fusionado", doc)
        self.assertIn("CI terminal verde del SHA exacto", doc)

        rows: dict[int, tuple[str, str, str]] = {}
        for line in doc.splitlines():
            if not line.startswith("| [#"):
                continue
            cells = [cell.strip() for cell in line.split("|")]
            self.assertEqual(len(cells), 6, f"Fila Markdown incorrecta: {line}")
            issue_match = ISSUE_LINK.fullmatch(cells[1])
            self.assertIsNotNone(issue_match, f"Issue sin link auténtico: {line}")
            issue = int(issue_match.group("number"))
            self.assertNotIn(issue, rows, f"Issue repetido: {issue}")
            decision, reason, evidence = cells[2:5]
            self.assertIn(decision, {"CERRAR", "ACTUALIZAR", "DEJAR ABIERTO"})
            self.assertGreaterEqual(len(reason), 35, f"Falta justificación: {issue}")
            self.assertGreaterEqual(len(EVIDENCE_LINK.findall(evidence)), 2,
                                    f"Falta evidencia GitHub verificable: {issue}")
            rows[issue] = (decision, reason, evidence)

        # Los únicos issues abiertos del corte son #465 y la propia hoja #600.
        self.assertEqual(set(rows), {465, 600})
        self.assertEqual(rows[465][0], "DEJAR ABIERTO")
        self.assertIn("synthetic_only", rows[465][1])
        self.assertIn("readiness=UNKNOWN", rows[465][1])
        self.assertEqual(rows[600][0], "ACTUALIZAR")
        self.assertIn("reserva V3", rows[600][1])
        self.assertIn("issuecomment-6387616153", rows[600][2])
        self.assertIn("Cerrados por esta auditoría:** ninguno", doc)
        self.assertIn("no altera servicios, datos personales, producción", doc)


if __name__ == "__main__":
    unittest.main()
