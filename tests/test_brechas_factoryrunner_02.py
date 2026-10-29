"""FactoryRunner #641: brechas de privacidad y observador, solo offline.

Los cinco IDs requieren prueba/autoridad real que este test no puede producir.
Los fixtures sintéticos y las plantillas legales nunca certifican tratamientos.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs/matriz-cobertura.md"

# ID -> documento, clase de evidencia externa requerida y límite sintético.
GAPS = {
    "LOC-13": ("docs/local-observer.md", "REAL"),
    "PA-01": ("docs/privacidad/aviso-privacidad.md", "OPERACIÓN"),
    "PA-02": ("docs/privacidad/aviso-privacidad.md", "REAL"),
    "PC-01": ("docs/privacidad/canal-derechos.md", "OPERACIÓN"),
    "PP-01": ("docs/privacidad/politica-tratamiento.md", "OPERACIÓN"),
}

LEGAL_REQUIREMENTS = {
    "PA-01": ("revisión jurídica requerida", "- Identificación: [COMPLETAR POR EL DUEÑO]", "- Canal de derechos: [COMPLETAR POR EL DUEÑO]"),
    "PA-02": ("casilla no premarcada", "evidencia verificable", "no acredita que exista consentimiento"),
    "PC-01": ("Requisitos de la solicitud: [COMPLETAR POR EL DUEÑO]", "Plazos aplicables: [COMPLETAR POR EL DUEÑO]", "verificarse antes de tramitar solicitudes"),
    "PP-01": ("no constituye aprobación jurídica", "review_required", "revisión jurídica aplicable"),
}


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def coverage_row(identifier: str, matrix: str | None = None) -> str:
    """Reject missing/duplicate IDs rather than choosing a convenient row."""
    if identifier not in GAPS:
        raise ValueError("ID fuera del alcance de la hoja")
    content = MATRIX.read_text(encoding="utf-8") if matrix is None else matrix
    rows = [line for line in content.splitlines() if line.startswith(f"| {identifier} / " + chr(96))]
    if len(rows) != 1:
        raise ValueError(f"{identifier}: se esperaba una sola fila; recibidas={len(rows)}")
    return rows[0]


def offline_status(identifier: str, row: str | None = None) -> str:
    """No elevar evidencia REAL/OPERACIÓN desde documentación sintética."""
    document, evidence_kind = GAPS[identifier]
    actual = coverage_row(identifier) if row is None else row
    fields = [part.strip() for part in actual.split("|")[1:-1]]
    if (len(fields) != 6 or not fields[0].startswith(f"{identifier} / " + chr(96) + document + chr(96))
            or fields[2] != "NO_VERIFICABLE" or fields[5] != evidence_kind):
        raise ValueError(f"{identifier}: fila ambigua o cambio sin prueba externa")
    # La matriz conserva una causa concreta, sin registrar pruebas operativas ficticias.
    if not fields[3] or ("Falta" not in fields[3] and "Faltan" not in fields[3]):
        raise ValueError(f"{identifier}: brecha no documentada")
    return "UNKNOWN"


class BrechasFactoryrunner02Tests(unittest.TestCase):
    def test_contrato_principal(self) -> None:
        """AC-01: cada ID tiene una brecha verificable o caso negativo específico."""
        self.assertEqual(set(GAPS), {"LOC-13", "PA-01", "PA-02", "PC-01", "PP-01"})
        for identifier, (document, _) in GAPS.items():
            with self.subTest(gap=identifier):
                self.assertTrue((ROOT / document).is_file())
                self.assertIn(document, coverage_row(identifier))
                self.assertEqual(offline_status(identifier), "UNKNOWN")
                if identifier in LEGAL_REQUIREMENTS:
                    for expected in LEGAL_REQUIREMENTS[identifier]:
                        self.assertIn(expected, read(document), f"{identifier}: {expected}")
        observer = read("docs/local-observer.md")
        adapter = read("src/local-observer-source-adapter.ts")
        self.assertIn("no están conectadas a una fuente de observación real", observer)
        self.assertIn("FRESH no autoriza READY ni live", observer)
        self.assertIn("provenance: 'synthetic', freshness: 'UNKNOWN'", adapter)
        self.assertIn("capacity: {total: snapshot.max_parallel, available: null}", adapter)

    def test_falla_cerrado(self) -> None:
        """AC-02: ausencia, duplicado y falso CUBIERTO nunca pasan."""
        for identifier in GAPS:
            with self.subTest(gap=identifier):
                row = coverage_row(identifier)
                for broken in ("", row + "\n" + row):
                    with self.assertRaises(ValueError):
                        coverage_row(identifier, broken)
                for broken in (
                    row.replace("NO_VERIFICABLE", "CUBIERTO"),
                    row.replace("Falta", "Acreditado").replace("Faltan", "Acreditados"),
                    row.replace(GAPS[identifier][1] + " |", "EVIDENCIA_SYNTHETIC |"),
                ):
                    with self.assertRaises(ValueError):
                        offline_status(identifier, broken)
                self.assertEqual(offline_status(identifier, row), "UNKNOWN")
        with self.assertRaises(ValueError):
            coverage_row("SIN-AUTORIZACIÓN")

    def test_sin_datos_reales(self) -> None:
        """AC-03: no red, PII ni credenciales; el adaptador usa solo fixtures."""
        source = read("src/local-observer-source-adapter.ts")
        self.assertIn("PURE fixture bridge", source)
        self.assertIn("No exception details or untrusted raw evidence may escape", source)
        self.assertNotRegex(source, r"from ['\"]node:(?:http|https|net|child_process)['\"]")
        doc = read("docs/local-observer.md")
        self.assertIn("No lee sesiones, procesos", doc)
        self.assertIn("sin fuentes reales", doc)
        for identifier in LEGAL_REQUIREMENTS:
            self.assertEqual(offline_status(identifier), "UNKNOWN")
        # El único test ejecutable externo observa fixtures deterministas;
        # no se conecta al Mac ni a un proveedor o sistema jurídico.

    def test_estados_unknown_explicitos(self) -> None:
        """AC-04: verificar el adaptador ya probado; FRESH tampoco es READY."""
        for identifier in GAPS:
            self.assertEqual(offline_status(identifier), "UNKNOWN", identifier)
        suite = read("tests/local-observer-source-adapter.test.ts")
        self.assertIn("synthetic capacity export renders only synthetic UNKNOWN", suite)
        self.assertIn("stale offline future and identity drift can never become FRESH", suite)
        self.assertIn("private sessions evidence UUID and local queue never leak", suite)
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test", "tests/local-observer-source-adapter.test.ts"],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=120,
        )
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-5000:])


if __name__ == "__main__":
    unittest.main()
