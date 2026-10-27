"""Contrato ejecutable de la matriz de cobertura documental de FactoryRunner #602."""
from __future__ import annotations

import re
import unittest
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATRIX = ROOT / "docs" / "matriz-cobertura.md"
STATES = {"CUBIERTO", "EN_CURSO", "SIN_COBERTURA", "DESCARTADO", "NO_VERIFICABLE"}
PHASES = {"OFFLINE", "REAL", "OPERACIÓN", "N/A"}
SOURCES = (
    "README.md",
    "docs/go-live-preflight.md",
    "docs/local-observer.md",
    "docs/reconciliacion-issues-20261024.md",
    "docs/recovery-database.md",
    "docs/recovery-google-drive.md",
    "docs/recovery-live-object-storage.md",
    "docs/recovery-object-storage.md",
    "docs/recovery-runtime-e2e.md",
    "docs/runner-kill-switch-rehearsal.md",
    "FactoryRunner/issues/465",
)
URL_ISSUE = re.compile(r"https://github[.]com/pl0n3r/FactoryRunner/issues/([1-9][0-9]*)")
URL_PR = re.compile(r"https://github[.]com/pl0n3r/FactoryRunner/pull/([1-9][0-9]*)")
ROW_ID = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]{2}$")


def _parse_matrix():
    text = MATRIX.read_text(encoding="utf-8")
    header = "| ID / fuente | Requisito resumido | Estado | Evidencia | Issue | Fase |"
    if text.count(header) != 1:
        raise AssertionError("La tabla principal debe tener una cabecera única")
    part = text.split(header, 1)[1]
    if "\n| --- | --- | --- | --- | --- | --- |" not in part:
        raise AssertionError("Tabla principal sin separador")
    part = part.split("\n| --- | --- | --- | --- | --- | --- |", 1)[1]
    part = part.split("\n## Resumen auditable", 1)[0]
    rows = []
    for raw in part.strip().splitlines():
        if not (raw.startswith("| ") and raw.endswith(" |")):
            raise AssertionError("Fila malformada: " + raw[:100])
        cells = [cell.strip() for cell in raw[1:-1].split("|")]
        if len(cells) != 6:
            raise AssertionError("Número de columnas incorrecto: " + raw[:100])
        rows.append(cells)
    return text, rows


class MatrizCoberturaTests(unittest.TestCase):
    def test_cubre_todas_las_fuentes(self):
        _, rows = _parse_matrix()
        self.assertGreaterEqual(len(rows), 60, "No se cubrieron las obligaciones mínimas")
        source_cells = [row[0] for row in rows]
        for src in SOURCES:
            with self.subTest(source=src):
                self.assertTrue(any(src in cell for cell in source_cells),
                                "Falta fuente normativa: " + src)
        # La matriz separa expresamente los requisitos offline de sus puertas operativas.
        for phase in ("OFFLINE", "REAL", "OPERACIÓN"):
            self.assertTrue(any(row[5] == phase for row in rows), phase)

    def test_sin_cobertura_tiene_issue(self):
        _, rows = _parse_matrix()
        for row in rows:
            state, issue = row[2], row[4]
            with self.subTest(id=row[0]):
                if state == "SIN_COBERTURA":
                    self.assertRegex(issue, URL_ISSUE)
                    self.assertNotIn("issues/602", issue, "No enlazar la propia matriz")
                if state == "EN_CURSO":
                    self.assertRegex(issue, URL_ISSUE)
                if state == "CUBIERTO":
                    self.assertRegex(row[3], URL_PR, "Cobertura exige PR fusionado")
                    self.assertRegex(row[3], r"\x60(?:src|tests|docs)/",
                                     "Cobertura exige ruta específica de código/prueba")

    def test_formato_y_estados(self):
        text, rows = _parse_matrix()
        ids = set()
        for row in rows:
            cell, requirement, state, evidence, issue, phase = row
            identifier = cell.split(" / ", 1)[0]
            with self.subTest(id=identifier):
                self.assertRegex(identifier, ROW_ID)
                self.assertNotIn(identifier, ids, "ID repetido")
                ids.add(identifier)
                self.assertIn(state, STATES)
                self.assertIn(phase, PHASES)
                self.assertIn(" / ", cell)
                for value in (requirement, evidence, issue):
                    self.assertTrue(value)
                if state == "NO_VERIFICABLE":
                    self.assertTrue(any(x in evidence.lower() for x in
                                        ("falta", "sin ", "no hay", "sólo", "solo")),
                                    "Explicar lo que falta para verificar")
                if state == "DESCARTADO":
                    self.assertTrue("D-063" in evidence or "fuera" in evidence.lower())
        self.assertIn("live_authorized=false", text)
        self.assertIn("synthetic_only", text)
        self.assertIn("readiness=UNKNOWN", text)

    def test_resumen_por_estado(self):
        text, rows = _parse_matrix()
        counts = Counter(row[2] for row in rows)
        section = text.split("## Resumen auditable", 1)[1]
        for state in ("CUBIERTO", "EN_CURSO", "SIN_COBERTURA",
                      "DESCARTADO", "NO_VERIFICABLE"):
            with self.subTest(state=state):
                self.assertIn(f"| {state} | {counts[state]} |", section)
        self.assertIn(f"| TOTAL | {len(rows)} |", section)
        actual = (Decimal(100) * Decimal(counts["CUBIERTO"])
                  / Decimal(len(rows))).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        self.assertIn(f"{actual}% CUBIERTO", section)
        self.assertIn(f"({counts['CUBIERTO']}/{len(rows)})", section)


if __name__ == "__main__":
    unittest.main()
