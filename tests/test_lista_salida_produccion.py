"""Offline launch-readiness checklist contract, FactoryRunner issue #604."""
from __future__ import annotations
import re
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "lista-salida-produccion.md"
AREAS = (
    "Respaldos y restauración", "Monitoreo y alertas",
    "Dominios, DNS y TLS", "Secretos y accesos", "Costos y límites",
    "Privacidad y aspectos legales", "Soporte y operación diaria",
    "Migración de datos", "Reversión y apagado de emergencia",
    "Seguridad y pruebas", "Accesibilidad y rendimiento",
    "Smoke de producción", "Credenciales del ejecutor",
    "Aislamiento de ejecuciones", "Recuperación base de datos",
    "Recuperación Google Drive", "Recuperación almacenamiento",
    "Kill switch ensayado", "Observador local auténtico",
)
STATES = {"LISTO", "EN_CURSO", "SIN_COBERTURA", "DEL_DUEÑO", "NO_APLICA"}
PHASES = {"OFFLINE", "OPERACIÓN", "N/A"}
CANONICAL_LEAVES = {"605", "606", "607", "608", "609"}
ISSUE_MD = re.compile(r"\[FR #([1-9][0-9]*)\]\(https://github[.]com/pl0n3r/FactoryRunner/issues/\1\)")
PR_MD = re.compile(r"\[PR #([1-9][0-9]*)\]\(https://github[.]com/pl0n3r/FactoryRunner/pull/\1\)")


def _read():
    content = SOURCE.read_text(encoding="utf-8")
    header = "| ID | Área | Requisito | Estado | Evidencia | Issue | Fase |"
    divider = "\n| --- | --- | --- | --- | --- | --- | --- |"
    if content.count(header) != 1 or divider not in content.split(header, 1)[1]:
        raise AssertionError("Cabecera o separador de siete columnas ausente")
    body = content.split(header, 1)[1].split(divider, 1)[1]
    if body.count("\n## Resumen final") != 1:
        raise AssertionError("Tabla no delimitada por Resumen final")
    body = body.split("\n## Resumen final", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        if not line.startswith("| ") or not line.endswith(" |"):
            raise AssertionError("Fila de tabla malformada: " + repr(line[:110]))
        cells = tuple(x.strip() for x in line[1:-1].split("|"))
        if len(cells) != 7:
            raise AssertionError("La fila debe tener 7 celdas: " + repr(line[:110]))
        rows.append(cells)
    return content, rows


class ListaSalidaTests(unittest.TestCase):
    def test_cubre_todo_el_alcance(self):
        content, rows = _read()
        self.assertGreaterEqual(len(rows), 65)
        for area in AREAS:
            with self.subTest(area=area):
                self.assertGreaterEqual(sum(row[1] == area for row in rows), 2)
        for marker in ("live_authorized=false", "readiness=UNKNOWN",
                       "synthetic_only", "#431/A", "#465", "#605",
                       "#606", "#607", "#608", "#609"):
            with self.subTest(marker=marker):
                self.assertIn(marker, content)
        for row in rows:
            if row[3] == "LISTO":
                self.assertEqual(row[6], "OFFLINE",
                                 "No confundir contrato con producción")

    def test_sin_cobertura_tiene_issue(self):
        _, rows = _read()
        gaps = []
        for row in rows:
            rid, _, _, status, evidence, issue, _ = row
            with self.subTest(id=rid):
                if status == "SIN_COBERTURA":
                    gaps.append(row)
                    match = ISSUE_MD.fullmatch(issue)
                    self.assertIsNotNone(match, "Enlace Markdown completo obligatorio")
                    self.assertIn(match.group(1), CANONICAL_LEAVES)
                    self.assertTrue(evidence.startswith("Falta "))
                elif status == "EN_CURSO":
                    self.assertIsNotNone(ISSUE_MD.fullmatch(issue))
                    self.assertNotIn("issues/465", issue)
                else:
                    self.assertEqual(issue, "—")
        self.assertGreaterEqual(len(gaps), 20)
        self.assertEqual(
            {ISSUE_MD.fullmatch(row[5]).group(1) for row in gaps},
            CANONICAL_LEAVES,
        )
        self.assertIsNone(ISSUE_MD.fullmatch(
            "[FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607"))
        self.assertIsNone(ISSUE_MD.fullmatch(
            "[FR #607](https://github.com/pl0n3r/FactoryRunner/issues/608)"))

    def test_formato_y_estados(self):
        _, rows = _read()
        seen = set()
        for rid, area, requirement, status, evidence, issue, phase in rows:
            with self.subTest(id=rid):
                self.assertRegex(rid, r"^[A-Z][A-Z0-9]*-[0-9]{2}$")
                self.assertNotIn(rid, seen)
                seen.add(rid)
                self.assertIn(area, AREAS)
                self.assertIn(status, STATES)
                self.assertIn(phase, PHASES)
                self.assertTrue(requirement and evidence)
                if status == "LISTO":
                    match = PR_MD.search(evidence)
                    self.assertIsNotNone(match, "LISTO exige PR verificable")
                    self.assertTrue(evidence.endswith(match.group(0)))
                    self.assertRegex(evidence, r"\x60(?:src|tests|docs|scripts)/")
                elif status == "DEL_DUEÑO":
                    self.assertTrue(evidence.startswith("Falta "))
                elif status == "NO_APLICA":
                    self.assertEqual(phase, "N/A")
                    self.assertTrue(evidence.startswith("Excluido: "))
        self.assertEqual(len(seen), len(rows))

    def test_resumen_final(self):
        content, rows = _read()
        section = content.split("## Resumen final", 1)[1]
        counts = Counter(row[3] for row in rows)
        for state in ("LISTO", "EN_CURSO", "SIN_COBERTURA",
                      "DEL_DUEÑO", "NO_APLICA"):
            with self.subTest(state=state):
                self.assertIn(f"| {state} | {counts[state]} |", section)
        self.assertIn(f"| TOTAL | {len(rows)} |", section)
        self.assertIn("Hojas nuevas creadas en este despacho: 3", section)
        self.assertIn("Hojas existentes reutilizadas: 2", section)
        self.assertIn(
            f"Sin cobertura todavía: {counts['SIN_COBERTURA']} filas",
            section,
        )
        for barrier in ("Decisión OWNER y legal", "Infraestructura y ControlBot",
                        "Continuidad real", "Operación/seguridad y smoke"):
            self.assertIn(barrier, section)


if __name__ == "__main__":
    unittest.main()
