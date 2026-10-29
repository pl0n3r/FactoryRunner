"""FactoryRunner #642: five offline gaps; never attest legal or live approval.

This suite reads only versioned project files with synthetic negative fixtures.
Passing it does not authorize publication, HTTPS connectivity, or processing PII.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = "docs/matriz-cobertura.md"
UNKNOWN = "UNKNOWN"

# Identifier -> canonical file, external evidence category, missing authority.
GAPS = {
    "PRG-01": (
        "docs/privacidad/registro-tratamientos.md", "REAL",
        "Falta comprobación legal y funcional",
    ),
    "PRT-01": (
        "docs/privacidad/retencion.md", "OPERACIÓN",
        "Faltan plazos autorizados y revisión jurídica",
    ),
    "PTC-01": (
        "docs/privacidad/terminos-condiciones.md", "OPERACIÓN",
        "Faltan condiciones del propietario y revisión jurídica",
    ),
    "PTC-02": (
        "docs/privacidad/terminos-condiciones.md", "OPERACIÓN",
        "Faltan datos identificativos y mecanismo de controversias aprobados",
    ),
    "RM-12": (
        "README.md", "REAL",
        "falta evidencia de conectividad real",
    ),
}

# These are precise, pending conditions in the actual versioned documents.
# A placeholder or review_required is NOT evidence of legal approval.
PENDING = {
    "PRG-01": (
        "runner_location_metadata", "Base documentada: `review_required`",
        "Consentimiento: `review_required`", "Retención: `review_required`",
        "Proveedores: ninguno_declarado", "revisión jurídica requerida",
    ),
    "PRT-01": (
        "runner_location_metadata", "| review_required | review_required |",
        "revisión jurídica requerida",
    ),
    "PTC-01": (
        "Condiciones comerciales: [COMPLETAR POR EL DUEÑO]",
        "Niveles de servicio (SLA), si aplican: [COMPLETAR POR EL DUEÑO]",
        "Garantías y limitaciones aplicables: [COMPLETAR POR EL DUEÑO]",
        "Jurisdicción y mecanismo de solución de controversias: [COMPLETAR POR EL DUEÑO]",
        "revisión jurídica requerida antes de publicación",
    ),
    "PTC-02": (
        "Identificación: [COMPLETAR POR EL DUEÑO]",
        "Canal de derechos: [COMPLETAR POR EL DUEÑO]",
        "mecanismo de solución de controversias: [COMPLETAR POR EL DUEÑO]",
    ),
    "RM-12": (
        "https://control.condorapp.com.co/",
        "acceso restringido; el enlace no certifica conexión del Runner",
        "sin go-live", "sin endpoint real conectado",
    ),
}


def read(relative_path: str) -> str:
    """Local files only: no production, service endpoints or credentials."""
    return (ROOT / relative_path).read_text(encoding="utf-8")


def coverage_row(identifier: str, matrix: str | None = None) -> tuple[str, ...]:
    """Require the exact sole row, preserving evidence category and unknown state."""
    if identifier not in GAPS:
        raise ValueError("fuera del alcance")
    raw = read(MATRIX) if matrix is None else matrix
    matches = [line for line in raw.splitlines()
               if line.startswith(f"| {identifier} / `")]
    if len(matches) != 1:
        raise ValueError(f"{identifier}: fila ausente o duplicada")
    row = matches[0]
    if not row.endswith("|"):
        raise ValueError(f"{identifier}: fila incompleta")
    columns = tuple(value.strip() for value in row.split("|")[1:-1])
    document, evidence_kind, reason = GAPS[identifier]
    if (len(columns) != 6
            or columns[0] != f"{identifier} / `{document}`"
            or not columns[1]
            or columns[2] != "NO_VERIFICABLE"
            or reason not in columns[3]
            or columns[4] != "—"
            or columns[5] != evidence_kind):
        raise ValueError(f"{identifier}: cobertura sin evidencia externa válida")
    return columns


def offline_status(identifier: str, matrix: str | None = None,
                   document: str | None = None) -> str:
    """Never promote code-only proof to LEGAL, REAL, OPERACIÓN or READY."""
    coverage_row(identifier, matrix)
    path, _, _ = GAPS[identifier]
    text = read(path) if document is None else document
    if not text or not all(marker in text for marker in PENDING[identifier]):
        raise ValueError(f"{identifier}: falta o cambió la evidencia pendiente")
    return UNKNOWN


class BrechasFactoryrunner03Tests(unittest.TestCase):
    def test_contrato_principal(self) -> None:
        """AC-01: all five rows retain concrete, independently checked gaps."""
        self.assertEqual(set(GAPS), {"PRG-01", "PRT-01", "PTC-01", "PTC-02", "RM-12"})
        for identifier, (path, kind, _) in GAPS.items():
            with self.subTest(gap=identifier):
                self.assertTrue((ROOT / path).is_file())
                self.assertEqual(coverage_row(identifier)[5], kind)
                self.assertEqual(offline_status(identifier), UNKNOWN)
        # README links to a restricted cockpit, not an authenticated live Runner.
        readme = read("README.md")
        self.assertIn("(acceso restringido; el enlace no certifica conexión del Runner)", readme)
        self.assertIn("sin endpoint real conectado", readme)

    def test_falla_cerrado(self) -> None:
        """AC-02: missing, duplicate, ambiguous or falsely 'covered' fail closed."""
        for identifier, (path, kind, _) in GAPS.items():
            with self.subTest(gap=identifier):
                row = "| " + " | ".join(coverage_row(identifier)) + " |"
                for invalid in (
                    "", row + "\n" + row,
                    row.replace("NO_VERIFICABLE", "CUBIERTO"),
                    row.replace(f"/ `{path}`", "/ `docs/other.md`"),
                    row.replace(f" | {kind} |", " | CERTIFICADO |"),
                    row.replace(" | — |", " | aprobado |"),
                    row.rsplit("|", 2)[0] + "|",
                ):
                    with self.assertRaises(ValueError):
                        coverage_row(identifier, invalid)
                source_document = read(path)
                for marker in PENDING[identifier]:
                    missing_marker_document = source_document.replace(marker, "")
                    with self.assertRaises(ValueError):
                        offline_status(identifier, row, missing_marker_document)
        with self.assertRaises(ValueError):
            coverage_row("FUERA-DEL-ALCANCE")

    def test_sin_datos_reales(self) -> None:
        """AC-03: offline-only, no secrets/PII and no legal authority inferred."""
        source = read("tests/test_brechas_factoryrunner_03.py")
        tree = ast.parse(source)
        imported = {
            alias.name.split(".")[0]
            for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in (node.names if isinstance(node, ast.Import) else
                          [ast.alias(name=node.module or "")])
        }
        self.assertLessEqual(imported, {"__future__", "ast", "unittest", "pathlib"})
        for identifier in GAPS:
            self.assertEqual(offline_status(identifier), UNKNOWN)
        self.assertIn("review_required", read("docs/privacidad/registro-tratamientos.md"))
        self.assertIn("[COMPLETAR POR EL DUEÑO]", read("docs/privacidad/terminos-condiciones.md"))

    def test_estados_unknown_explicitos(self) -> None:
        """AC-04: evidence type REAL/OPERACIÓN never becomes synthetic success."""
        for identifier, (_, kind, _) in GAPS.items():
            with self.subTest(gap=identifier):
                self.assertIn(kind, ("REAL", "OPERACIÓN"))
                self.assertEqual(offline_status(identifier), UNKNOWN)
        # A bare https URL and a working fake transport do not prove connectivity.
        self.assertIn("no hay integración live ni despliegue acreditado", read("README.md"))
        self.assertIn("acceso restringido", read("README.md"))


if __name__ == "__main__":
    unittest.main()
