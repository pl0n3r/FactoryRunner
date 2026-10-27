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
    "docs/privacidad/aviso-privacidad.md",
    "docs/privacidad/canal-derechos.md",
    "docs/privacidad/politica-tratamiento.md",
    "docs/privacidad/registro-tratamientos.md",
    "docs/privacidad/retencion.md",
    "docs/privacidad/terminos-condiciones.md",
)
URL_ISSUE = re.compile(r"\[FR #([1-9][0-9]*)\]\(https://github[.]com/pl0n3r/FactoryRunner/issues/\1\)")
URL_PR = re.compile(r"\[PR #([1-9][0-9]*)\]\(https://github[.]com/pl0n3r/FactoryRunner/pull/\1\)")
NEW_LEAVES = {"605", "606"}
EXECUTABLE_IN_PROGRESS = {"604"}  # #465 planificado y #1 roadmap no aplican
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
        self.assertGreaterEqual(len(rows), 77, "No se cubrieron las obligaciones mínimas")
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
                    match = URL_ISSUE.fullmatch(issue)
                    self.assertIsNotNone(match, "Issue requiere enlace Markdown completo")
                    self.assertIn(match.group(1), NEW_LEAVES, "Falta hoja de remediación canónica")
                    self.assertNotIn("issues/465", issue, "Un plan no sustituye una hoja")
                if state == "EN_CURSO":
                    match = URL_ISSUE.fullmatch(issue)
                    self.assertIsNotNone(match, "Issue requiere enlace Markdown completo")
                    self.assertIn(match.group(1), EXECUTABLE_IN_PROGRESS,
                                  "Sólo hojas ejecutables, nunca épicas ni planificación")
                if state == "CUBIERTO":
                    found = URL_PR.search(row[3])
                    self.assertIsNotNone(found, "Cobertura exige PR con enlace Markdown completo")
                    self.assertTrue(row[3].endswith(found.group(0)), "Enlace PR debe cerrar la evidencia")
                    self.assertRegex(row[3], r"\x60(?:src|tests|docs)/",
                                     "Cobertura exige ruta específica de código/prueba")

    def test_regresion_enlaces_markdown(self):
        self.assertIsNone(URL_ISSUE.fullmatch("[FR #605](https://github.com/pl0n3r/FactoryRunner/issues/605"))
        self.assertIsNone(URL_ISSUE.fullmatch("[FR #605](https://github.com/pl0n3r/FactoryRunner/issues/999)"))
        self.assertIsNone(URL_PR.search("[PR #42](https://github.com/pl0n3r/FactoryRunner/pull/42"))
        self.assertIsNotNone(URL_ISSUE.fullmatch("[FR #606](https://github.com/pl0n3r/FactoryRunner/issues/606)"))

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
        self.assertIn("**2**", section, "Registrar el número de hojas nuevas")
        actual = (Decimal(100) * Decimal(counts["CUBIERTO"])
                  / Decimal(len(rows))).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        self.assertIn(f"{actual}% CUBIERTO", section)
        self.assertIn(f"({counts['CUBIERTO']}/{len(rows)})", section)


if __name__ == "__main__":
    unittest.main()
