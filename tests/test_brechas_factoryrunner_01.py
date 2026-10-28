"""Regresiones offline de cinco brechas operativas FactoryRunner #640.

Estas pruebas ejercitan los adapters con los drivers simulados existentes.
NO certifican cuentas/proveedores reales, permisos, restores ni go-live.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs" / "matriz-cobertura.md"

# Cada identificador conserva su procedencia y una regresión ejecutable.
GAPS = {
    "DB-04": (
        "docs/recovery-database.md",
        "tests/recovery-database-adapter.test.ts",
        "restore is disposable only and rejects production targets",
    ),
    "GD-04": (
        "docs/recovery-google-drive.md",
        "tests/recovery-google-drive-adapter.test.ts",
        "driver boundary rejects credential material URLs and extra fields",
    ),
    "GL-05": (
        "docs/go-live-preflight.md",
        "tests/go-live-preflight.test.ts",
        "reports cannot elevate live authority regardless of gate combinations",
    ),
    "GL-07": (
        "docs/go-live-preflight.md",
        "tests/go-live-preflight.test.ts",
        "missing, stale and failed offline proof are fail closed",
    ),
    "LO-07": (
        "docs/recovery-live-object-storage.md",
        "tests/recovery-live-object-storage.test.ts",
        "missing suspended or unknown versioning fails closed before object operation",
    ),
}

# Otra regresión negativa para Object Lock, independiente de versioning.
OBJECT_LOCK_NEGATIVE = (
    "missing disabled or unknown Object Lock fails closed before object operation"
)


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def coverage_row(identifier: str) -> str:
    matches = [
        line for line in MATRIX.read_text(encoding="utf-8").splitlines()
        if line.startswith(f"| {identifier} / `")
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"{identifier}: se esperaba una sola fila canónica, hay {len(matches)}"
        )
    return matches[0]


def offline_operational_status(identifier: str) -> str:
    """Interpretación conservadora de la matriz, NO evidencia del proveedor."""
    row = coverage_row(identifier)
    if "| NO_VERIFICABLE |" in row and row.rstrip().endswith("| OPERACIÓN |"):
        return "UNKNOWN"
    raise AssertionError(f"{identifier}: cambió la clasificación sin evidencia real")


class BrechasFactoryrunner01Tests(unittest.TestCase):
    def test_contrato_principal(self):
        """AC-01: las cinco filas enlazan un caso real de la suite sintética."""
        self.assertEqual(
            set(GAPS), {"DB-04", "GD-04", "GL-05", "GL-07", "LO-07"}
        )
        for identifier, (document, suite, negative_case) in GAPS.items():
            with self.subTest(gap=identifier):
                row = coverage_row(identifier)
                self.assertIn(document, row)
                self.assertIn("| NO_VERIFICABLE |", row)
                self.assertTrue(row.rstrip().endswith("| OPERACIÓN |"))
                self.assertTrue((ROOT / document).is_file())
                self.assertIn(negative_case, read(suite))
        self.assertIn(
            OBJECT_LOCK_NEGATIVE,
            read("tests/recovery-live-object-storage.test.ts"),
        )

    def test_falla_cerrado(self):
        """AC-02: ejecutar regresiones existentes con drivers inyectados.

        Incluyen destino DB no descartable, OAuth/URL, permisos o pruebas
        ambiguas, restore sintético y preflight S3 sin versión/Object Lock.
        """
        suites = sorted({suite for _, suite, _ in GAPS.values()})
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--test", "--test-reporter=tap", *suites],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        output = completed.stdout + "\n" + completed.stderr
        self.assertEqual(completed.returncode, 0, output[-6000:])
        self.assertIn("# fail 0", completed.stdout)
        for identifier, (_, _, negative_case) in GAPS.items():
            with self.subTest(gap=identifier):
                self.assertIn(negative_case, completed.stdout)
        self.assertIn(OBJECT_LOCK_NEGATIVE, completed.stdout)

    def test_sin_datos_reales(self):
        """AC-03: todas las dependencias son fixtures, sin acceso del test a red."""
        db = read("tests/recovery-database-adapter.test.ts")
        drive = read("tests/recovery-google-drive-adapter.test.ts")
        live = read("tests/recovery-live-object-storage.test.ts")
        preflight = read("tests/go-live-preflight.test.ts")
        self.assertIn("FakeDb", db)
        self.assertIn("FakeDrive", drive)
        self.assertIn("RecoveryS3Transport", live)
        self.assertIn("preflightResponse", live)
        self.assertIn("allProofs", preflight)
        self.assertIn("no real database or process implementation", db)
        self.assertIn("network/provider implementations stay outside", drive)
        # La invocación de Node es local y sus casos usan drivers/transport
        # inyectados. No se introducen credenciales ni identificadores reales.

    def test_estados_unknown_explicitos(self):
        """AC-04: ningún fixture se puede convertir en certificación operativa."""
        for identifier in GAPS:
            with self.subTest(gap=identifier):
                self.assertEqual(offline_operational_status(identifier), "UNKNOWN")
        doc = read("docs/go-live-preflight.md")
        source = read("src/go-live-preflight.ts")
        tests = read("tests/go-live-preflight.test.ts")
        self.assertIn("live_authorized=false", doc)
        self.assertIn("readiness=UNKNOWN", doc)
        self.assertIn("live_authorized: false as const", source)
        self.assertIn("readiness: 'UNKNOWN' as const", source)
        self.assertIn("assert.equal(report.live_authorized, false)", tests)
        self.assertIn("assert.equal(report.readiness, 'UNKNOWN')", tests)


if __name__ == "__main__":
    unittest.main()
