"""Contrato offline #614: un contraste no certifica operaciones o aprobación jurídica."""
from __future__ import annotations

from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs" / "matriz-cobertura.md"
REPORT = ROOT / "docs" / "contraste-fr_todo.md"
ID = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]{2}$")
ISSUE_URL = re.compile(r"https://github\.com/pl0n3r/FactoryRunner/issues/\d+")
MERGED_PR = re.compile(r"https://github\.com/pl0n3r/FactoryRunner/pull/\d+.*fusionad", re.I)
QUOTE = chr(96)


def read_rows(text, report=False):
    if report:
        section = text.split("## Veredictos por fila", 1)[1].split("## Alcance y continuidad", 1)[0]
        size = 7
    else:
        section = text.split("## Resumen auditable", 1)[0]
        size = 6
    result = {}
    for raw in section.splitlines():
        if not (raw.startswith("| ") and raw.endswith(" |")):
            continue
        cells = [part.strip() for part in raw[1:-1].split("|")]
        if len(cells) != size:
            continue
        key = cells[0] if report else cells[0].split(" / ", 1)[0]
        if not ID.fullmatch(key):
            continue
        if key in result:
            raise ValueError("ID duplicado: " + key)
        result[key] = cells
    return result


def verify(audit, matrix):
    for key, row in audit.items():
        _id, source, artifact, test, state, gap, phase = row
        if key not in matrix or matrix[key][2] != state:
            raise ValueError("fila o estado distinto: " + key)
        if not source or phase not in ("REAL", "OPERACIÓN") or len(gap) < 20:
            raise ValueError("evidencia incompleta")
        if not artifact.startswith(QUOTE) or not artifact.endswith(QUOTE):
            raise ValueError("archivo sin referencia")
        if not (ROOT / artifact[1:-1]).is_file():
            raise ValueError("archivo inexistente: " + key)
        if test != "SIN PRUEBA":
            if not test.startswith(QUOTE) or not test.endswith(QUOTE):
                raise ValueError("ruta de prueba inválida")
            if not test[1:-1].startswith("tests/") or not (ROOT / test[1:-1]).is_file():
                raise ValueError("prueba inexistente: " + key)
        if state == "NO_VERIFICABLE" and not any(
            token in gap.lower() for token in ("falta", "sin ", "sólo", "solo")
        ):
            raise ValueError("NO_VERIFICABLE exige brecha")
        if state == "CUBIERTO" and (test == "SIN PRUEBA" or not MERGED_PR.search(gap)):
            raise ValueError("CUBIERTO sin test y PR fusionado")
        if state == "SIN_COBERTURA" and (
            "factory-plan-task" not in gap or not ISSUE_URL.search(gap)
        ):
            raise ValueError("SIN_COBERTURA sin hoja canónica")


class ContrasteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.matrix_text = MATRIX.read_text(encoding="utf-8")
        cls.report_text = REPORT.read_text(encoding="utf-8")
        cls.matrix = read_rows(cls.matrix_text)
        cls.audit = read_rows(cls.report_text, report=True)

    def test_cada_fila_tiene_veredicto(self):
        expected = {key for key, row in self.matrix.items()
                    if row[2] == "NO_VERIFICABLE"}
        self.assertEqual(22, len(expected))
        self.assertEqual(expected, set(self.audit))
        verify(self.audit, self.matrix)
        duplicated = self.report_text.replace("| RM-08 |", "| RM-12 |", 1)
        with self.assertRaisesRegex(ValueError, "duplicado"):
            read_rows(duplicated, report=True)

    def test_cubierto_enlaza_prueba_existente(self):
        self.assertFalse(any(row[4] == "CUBIERTO" for row in self.audit.values()))
        fake = {key: list(row) for key, row in self.audit.items()}
        fake["RM-08"][4] = "CUBIERTO"
        mat = {key: list(row) for key, row in self.matrix.items()}
        mat["RM-08"][2] = "CUBIERTO"
        with self.assertRaisesRegex(ValueError, "PR fusionado"):
            verify(fake, mat)
        fake["RM-08"][3] = QUOTE + "tests/inexistente_de_cobertura.py" + QUOTE
        with self.assertRaisesRegex(ValueError, "prueba inexistente"):
            verify(fake, mat)

    def test_faltante_tiene_issue(self):
        self.assertFalse(any(row[4] == "SIN_COBERTURA" for row in self.audit.values()))
        fake = {key: list(row) for key, row in self.audit.items()}
        fake["GL-05"][4] = "SIN_COBERTURA"
        mat = {key: list(row) for key, row in self.matrix.items()}
        mat["GL-05"][2] = "SIN_COBERTURA"
        with self.assertRaisesRegex(ValueError, "hoja canónica"):
            verify(fake, mat)

    def test_matriz_actualizada(self):
        self.assertEqual("DESCARTADO", self.matrix["CT-01"][2])
        self.assertIn("docs/contraste-fr_todo.md", self.matrix["CT-01"][0])
        for key, row in self.audit.items():
            with self.subTest(key=key):
                self.assertIn("Contraste #614", self.matrix[key][3])
                self.assertIn(row[2][1:-1], self.matrix[key][3])
                if row[3] != "SIN PRUEBA":
                    self.assertIn(row[3][1:-1], self.matrix[key][3])
                self.assertEqual("NO_VERIFICABLE", self.matrix[key][2])
        counts = Counter(row[2] for row in self.matrix.values())
        self.assertEqual(78, len(self.matrix))
        self.assertEqual(47, counts["CUBIERTO"])
        self.assertEqual(22, counts["NO_VERIFICABLE"])
        self.assertEqual(2, counts["DESCARTADO"])
        summary = self.matrix_text.split("## Resumen auditable", 1)[1]
        for state in ("CUBIERTO", "EN_CURSO", "SIN_COBERTURA", "DESCARTADO", "NO_VERIFICABLE"):
            self.assertIn(f"| {state} | {counts[state]} |", summary)
        self.assertIn("| TOTAL | 78 |", summary)
        ratio = (Decimal(100) * Decimal(counts["CUBIERTO"]) / Decimal(78)).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP
        )
        self.assertIn(f"{ratio}% CUBIERTO", summary)
        self.assertIn("readiness=UNKNOWN", self.matrix_text)


if __name__ == "__main__":
    unittest.main()
