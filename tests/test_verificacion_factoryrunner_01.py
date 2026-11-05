"""#693: verificación fail-closed de 16 obligaciones, únicamente con datos sintéticos.

Los tests existentes prueban comportamiento real TS/Python con fakes, no autenticación
de sistemas externos. La auditoría no lee red productiva ni modifica la matriz.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs/matriz-cobertura.md"
REPORT = ROOT / "docs/verificacion/verificacion-01.md"
# id, estado en matriz, fase, documento normativo, predicado, testigo, caso, hoja.
CASES = (
    ("RM-07", "SIN_COBERTURA", "REAL", "README.md", "Conexión a ControlBot real con transporte/identidad autorizados", "tests/controlbot-client-contracts.test.ts", "poll rejects identical and conflicting duplicate order ids", "#605"),
    ("RM-08", "NO_VERIFICABLE", "OPERACIÓN", "README.md", "Runner desplegado en Hostinger con /health y SHA exactos", "tests/go-live-preflight.test.ts", "all offline proofs enable preparation but never operation", "—"),
    ("RM-12", "NO_VERIFICABLE", "REAL", "README.md", "Sin HTTPS o credenciales reales desde README/cockpit", "tests/test_factoryrunner_https_transport.py", "FactoryRunnerHttpsTransportTests.test_transport_timeout_http_error_or_sensitive_output_fails_closed", "—"),
    ("RM-13", "NO_VERIFICABLE", "REAL", "README.md", "No evadir CAPTCHA, MFA ni rate limits del proveedor", "tests/remote-adapters-no-evasion.test.ts", "CAPTCHA, MFA and rate limits stop every remote adapter with one request and unchanged identity", "—"),
    ("RM-14", "NO_VERIFICABLE", "REAL", "README.md", "Runner no amplía por sí mismo capacidades ni autoridad", "tests/runner-no-self-escalation.test.ts", "unregistered execution requests are rejected, recorded and never expand manifest", "—"),
    ("GL-04", "SIN_COBERTURA", "REAL", "docs/go-live-preflight.md", "HEALTH y protocolo de ControlBot real autenticados", "tests/controlbot-health-contract.test.ts", "unsigned, malformed, changed or untrusted evidence fails closed", "#605"),
    ("GL-05", "NO_VERIFICABLE", "OPERACIÓN", "docs/go-live-preflight.md", "Aprobación legal/privacidad antes de PII y sesiones reales", "tests/go-live-preflight.test.ts", "reports cannot elevate live authority regardless of gate combinations", "—"),
    ("GL-06", "NO_VERIFICABLE", "OPERACIÓN", "docs/go-live-preflight.md", "Hostinger permisos, endpoints HTTPS y credenciales por operación", "tests/go-live-preflight.test.ts", "ambiguous, spoofed or invalid evidence never accepted", "#608"),
    ("GL-07", "NO_VERIFICABLE", "OPERACIÓN", "docs/go-live-preflight.md", "Backup con restauración y rollback reales verificados", "tests/recovery-rehearsal-plan.test.ts", "AC-04 no synthetic outcome grants real backup, restore, rollback or live authority", "#608"),
    ("GL-08", "NO_VERIFICABLE", "OPERACIÓN", "docs/go-live-preflight.md", "Switch, smoke, version y SHA comprobados en desplegado real", "tests/kill-switch-rollback-rehearsal.test.ts", "AC-01 tras el kill switch no se aceptan ejecuciones nuevas", "#608"),
    ("LOC-11", "SIN_COBERTURA", "REAL", "docs/local-observer.md", "Fuente de observación real autenticada y autorizada", "tests/local-observer-source-adapter.test.ts", "AC01 synthetic capacity export renders only synthetic UNKNOWN observer view", "#606"),
    ("LOC-12", "SIN_COBERTURA", "OPERACIÓN", "docs/local-observer.md", "Capacidad READY y heartbeat genuinos desde runners desplegados", "tests/local-observer-empty-roster.test.ts", "AC01 renderer direct FRESH empty roster rejects positive capacity", "#606"),
    ("LOC-13", "NO_VERIFICABLE", "REAL", "docs/local-observer.md", "Datos de usuario fuera de UI sin revisión de privacidad", "tests/local-observer-no-pii.test.ts", "AC-02: missing, ambiguous and poisoned personal data always fail closed", "#606"),
    ("RC-04", "SIN_COBERTURA", "OPERACIÓN", "docs/reconciliacion-issues-20261024.md", "Readiness real de #465 aún pendiente", "tests/go-live-preflight.test.ts", "reports cannot elevate live authority regardless of gate combinations", "#465/#606"),
    ("DB-04", "NO_VERIFICABLE", "OPERACIÓN", "docs/recovery-database.md", "Snapshot/restauración real DB verificados", "tests/recovery-database-adapter.test.ts", "restore is disposable only and rejects production targets", "#608"),
    ("GD-04", "NO_VERIFICABLE", "OPERACIÓN", "docs/recovery-google-drive.md", "Operación Drive con cuenta/permisos reales", "tests/recovery-google-drive-adapter.test.ts", "driver boundary rejects credential material URLs and extra fields", "#608"),
)

def matrix_rows(text: str) -> dict[str, tuple[str, str, str, str]]:
    """No inferir estados desde resúmenes; exigir la tabla canónica exacta."""
    found = {}
    for line in text.splitlines():
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 8:
            continue
        matched = re.fullmatch(r"([A-Z]+-\d+) / \x60([^\x60]+)\x60", parts[1])
        if matched is None:
            continue
        identifier, source = matched.groups()
        if identifier in found:
            raise ValueError(f"ID duplicado: {identifier}")
        found[identifier] = (parts[2], parts[3], source, parts[6])
    return found


def report_rows(text: str) -> dict[str, tuple[str, str, str, str, str, str, str]]:
    """Leer las siete columnas verificables, sin elevar pruebas offline a operación."""
    found = {}
    for line in text.splitlines():
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 10 or not re.fullmatch(r"\x60([A-Z]+-\d+)\x60", parts[1]):
            continue
        identifier = parts[1].strip("\x60")
        if identifier in found:
            raise ValueError(f"Testigo duplicado: {identifier}")
        found[identifier] = (
            parts[2].strip("\x60"), parts[3].strip("\x60"),
            parts[4].strip("\x60"), parts[5].strip("\x60"),
            parts[6].strip("\x60"), parts[7].strip("\x60"),
            parts[8].strip("\x60"),
        )
    return found


class VerificacionFactoryRunner01Tests(unittest.TestCase):
    def test_16_predicados_y_estados_exactos_de_matriz(self):
        matrix = matrix_rows(MATRIX.read_text(encoding="utf-8"))
        report = report_rows(REPORT.read_text(encoding="utf-8"))
        self.assertEqual(len(CASES), 16)
        self.assertEqual(len({item[0] for item in CASES}), 16)
        self.assertEqual(set(report), {item[0] for item in CASES})
        self.assertEqual(sum(row[1] == "SIN_COBERTURA" for row in CASES), 5)
        self.assertEqual(sum(row[1] == "NO_VERIFICABLE" for row in CASES), 11)
        for identifier, state, phase, source, claim, witness, title, child in CASES:
            with self.subTest(row=identifier):
                self.assertEqual(matrix[identifier], (claim, state, source, phase))
                self.assertEqual(
                    report[identifier],
                    (state, phase, source, claim, witness, title, child),
                )

    def test_testigos_reales_son_ejecutables_y_anclados_a_producto(self):
        for identifier, state, phase, source, claim, witness, title, child in CASES:
            with self.subTest(row=identifier):
                path = ROOT / witness
                self.assertTrue(path.is_file(), witness)
                body = path.read_text(encoding="utf-8")
                if witness.endswith(".test.ts"):
                    self.assertIn("test('" + title + "'", body)
                    self.assertRegex(body, r"from ['\"]\.\./(?:src|scripts)/")
                    self.assertIn("assert.", body)
                else:
                    self.assertIn("def " + title.split(".")[-1] + "(", body)
                    self.assertTrue("subprocess.run" in body or "subprocess.check_output" in body)
        self.assertIn("execution plane", (ROOT / "README.md").read_text())
        self.assertIn("synthetic_only", (ROOT / "docs/local-observer.md").read_text())

    def test_negativos_inventario_y_evidencia_no_pueden_pasar(self):
        expected = {row[0] for row in CASES}
        raw = REPORT.read_text(encoding="utf-8")
        row = next(line for line in raw.splitlines() if line.startswith("| \x60RM-07\x60"))
        self.assertNotEqual(set(report_rows(raw.replace(row, "", 1))), expected)
        with self.assertRaises(ValueError):
            report_rows(raw + "\n" + row)
        self.assertNotEqual(
            report_rows(raw.replace(row, row.replace("SIN_COBERTURA", "CUBIERTO"), 1))["RM-07"][0],
            "SIN_COBERTURA",
        )
        source = MATRIX.read_text(encoding="utf-8")
        damaged = source.replace(
            "| RM-07 / \x60README.md\x60 |", "| RM-07 / \x60FAKE.md\x60 |", 1
        )
        self.assertNotEqual(matrix_rows(damaged)["RM-07"], matrix_rows(source)["RM-07"])

    def test_contratos_typescript_reales_con_escenarios_adversos(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node 24+ es necesario: no saltar testigos")
        modules = sorted({r[5] for r in CASES if r[5].endswith(".test.ts")})
        completed = subprocess.run(
            [node, "--experimental-strip-types", "--test", *modules],
            cwd=ROOT, text=True, capture_output=True, timeout=160, check=False,
        )
        self.assertEqual(completed.returncode, 0,
                         completed.stdout[-2500:] + "\n" + completed.stderr[-2500:])

    def test_contrato_https_python_con_transporte_falso(self):
        completed = subprocess.run(
            [sys.executable, "-m", "unittest", "-v",
             "tests.test_factoryrunner_https_transport."
             "FactoryRunnerHttpsTransportTests."
             "test_transport_timeout_http_error_or_sensitive_output_fails_closed"],
            cwd=ROOT, text=True, capture_output=True, timeout=90, check=False,
        )
        self.assertEqual(completed.returncode, 0,
                         completed.stdout[-1200:] + "\n" + completed.stderr[-2000:])

    def test_no_produccion_y_remediaciones_no_duplica_autoridad(self):
        report = REPORT.read_text(encoding="utf-8")
        for snippet in (
            "NO_VERIFICABLE", "SIN_COBERTURA", "#605", "#606",
            "#465", "live_authorized=false", "UNKNOWN",
            "No hay recibo productivo", "no acredita", "no permite go-live",
        ):
            self.assertIn(snippet, report)
        self.assertIn("phase", (ROOT / "datos.yml").read_text())
        self.assertIn('"construccion"', (ROOT / "datos.yml").read_text())
        self.assertNotIn("VALIDATED_IN_PRODUCTION = true", report)
        self.assertNotIn("READY = true", report)


if __name__ == "__main__":
    unittest.main()
