"""FactoryRunner #643: tres brechas de cobertura con evidencia offline fail-closed.

Las suites existentes solo ejercitan fakes o límites de código. Nunca certifican
CAPTCHA/MFA/rate limits de un proveedor, autoridad de conexión real ni restore live.
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs/matriz-cobertura.md"
UNKNOWN = "UNKNOWN"

# ID, documento, clasificación de evidencia, caso ejecutable sintético.
GAPS = {
    "RM-13": (
        "README.md", "REAL",
        "tests/remote-adapters-no-evasion.test.ts",
        "CAPTCHA, MFA and rate limits stop every remote adapter with one request and unchanged identity",
    ),
    "RM-14": (
        "README.md", "REAL",
        "tests/test_factoryrunner_admission.py",
        "test_zero_capacity_waits_and_invalid_drift_or_stale_input_blocks_fail_closed",
    ),
    "RT-05": (
        "docs/recovery-runtime-e2e.md", "OPERACIÓN",
        "tests/recovery-runtime-e2e.test.ts",
        "cross-provider and cross-capability inputs fail closed before fake drivers run",
    ),
}

# Ausencia de proveedores/autoridad operativa: ningún fixture habilita GREEN.
EXTERNAL_GAPS = {
    "RM-13": "provider_challenges_and_rate_limits_unobserved",
    "RM-14": "real_connection_execution_authority_unobserved",
    "RT-05": "real_backup_restore_identity_and_providers_unobserved",
}


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def row_for(identifier: str, matrix: str | None = None) -> tuple[str, ...]:
    if identifier not in GAPS:
        raise ValueError("ID fuera de alcance")
    raw = read("docs/matriz-cobertura.md") if matrix is None else matrix
    if not isinstance(raw, str):
        raise ValueError("Matriz ilegible")
    matches = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = tuple(cell.strip() for cell in stripped.strip("|").split("|"))
        if cells[0] == f"{identifier} / " + chr(96) + GAPS[identifier][0] + chr(96):
            matches.append(cells)
    if len(matches) != 1:
        raise ValueError(f"{identifier}: fila ausente o ambigua")
    cells = matches[0]
    if (
        len(cells) != 6
        or not all(cells[:4])
        or cells[2] != "NO_VERIFICABLE"
        or cells[5] != GAPS[identifier][1]
        or not ("Falta" in cells[3] or "faltan" in cells[3].lower())
    ):
        raise ValueError(f"{identifier}: matriz no acredita estado")
    return cells


def offline_status(identifier: str, matrix: str | None = None,
                   alleged_evidence: object = None) -> str:
    """Solo un observador/proveedor real y una autorización externa acreditan live.

    'alleged_evidence' se ignora deliberadamente: el test no verifica identidad
    ni autenticidad externas, aunque un fixture diga success/ready/green.
    """
    row_for(identifier, matrix)
    return UNKNOWN


def run_synthetic_tests(*args: str) -> str:
    proc = subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True,
        check=False, timeout=120,
    )
    result = proc.stdout + "\n" + proc.stderr
    if proc.returncode != 0:
        raise AssertionError(result[-5000:])
    return result


class BrechasFactoryrunner04Tests(unittest.TestCase):
    def test_contrato_principal(self):
        """AC-01: los tres IDs apuntan a pruebas reales y sus límites operativos."""
        self.assertEqual(set(GAPS), {"RM-13", "RM-14", "RT-05"})
        self.assertEqual(set(EXTERNAL_GAPS), set(GAPS))
        for identifier, (doc, kind, suite, case) in GAPS.items():
            with self.subTest(identifier=identifier):
                cells = row_for(identifier)
                self.assertIn(doc, cells[0])
                self.assertEqual(cells[2], "NO_VERIFICABLE")
                self.assertEqual(cells[5], kind)
                self.assertTrue((ROOT / doc).is_file())
                self.assertTrue((ROOT / suite).is_file())
                self.assertIn(case, read(suite))
                self.assertEqual(offline_status(identifier), UNKNOWN)

        browser = read("tests/browser-adapter-contracts.test.ts")
        admission = read("tests/test_factoryrunner_admission.py")
        recovery = read("tests/recovery-runtime-e2e.test.ts")
        self.assertIn("browser navigation requires allowlisted HTTPS origin", browser)
        remote = read("tests/remote-adapters-no-evasion.test.ts")
        self.assertIn("unknown, missing and malformed remote challenge responses fail closed", remote)
        self.assertIn("origin allowlist remains fixed despite a challenge", remote)
        self.assertIn("click/type use opaque refs and type rejects sensitive", browser)
        self.assertIn("manifestDrift", admission)
        self.assertIn("resourceDrift", admission)
        self.assertIn("database snapshot and disposable restore", recovery)
        self.assertIn("restore_disposable", recovery)

    def test_falla_cerrado(self):
        """AC-02: ejecutar negativos reales; matriz faltante/duplicada no pasa."""
        node_out = run_synthetic_tests(
            "node", "--experimental-strip-types", "--test",
            "--test-reporter=tap",
            "tests/browser-adapter-contracts.test.ts",
            "tests/remote-adapters-no-evasion.test.ts",
            "tests/recovery-runtime-e2e.test.ts",
        )
        self.assertIn("# fail 0", node_out)
        for identifier in ("RM-13", "RT-05"):
            self.assertIn(GAPS[identifier][3], node_out)
        py_out = run_synthetic_tests(
            sys.executable, "-m", "unittest", "discover", "-s", "tests",
            "-p", "test_factoryrunner_admission.py", "-v",
        )
        self.assertIn(GAPS["RM-14"][3], py_out)
        self.assertIn("OK", py_out)

        matrix = read("docs/matriz-cobertura.md")
        for identifier in GAPS:
            with self.subTest(identifier=identifier):
                original = next(
                    line for line in matrix.splitlines()
                    if line.strip().startswith("| " + identifier + " / ")
                )
                for malformed in (
                    "", matrix.replace(original, "", 1),
                    matrix + "\n" + original,
                    matrix + "\n  " + original,
                    matrix.replace(
                        original,
                        original.replace("NO_VERIFICABLE", "CUBIERTO", 1),
                        1,
                    ),
                    matrix.replace(original, original.replace(
                        "Falta", "Acreditada").replace("faltan", "acreditadas"), 1),
                ):
                    with self.subTest(sample=str(malformed)[:24]):
                        with self.assertRaises(ValueError):
                            row_for(identifier, malformed)
        with self.assertRaises(ValueError):
            offline_status("RM-NO-EXISTE")

    def test_sin_datos_reales(self):
        """AC-03: solo subprocess local a suites existentes y fakes explícitos."""
        script = read("tests/test_brechas_factoryrunner_04.py")
        tree = ast.parse(script)
        imports = {
            item.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for item in node.names
        }
        self.assertFalse(
            imports & {"requests", "socket", "urllib", "http", "ftplib"}
        )
        self.assertIn("class FakeDriver", read(
            "tests/browser-adapter-contracts.test.ts"))
        self.assertIn("const transport: BrowserRemoteTransport", read(
            "tests/remote-adapters-no-evasion.test.ts"))
        recovery = read("tests/recovery-runtime-e2e.test.ts")
        self.assertIn("objectDriver:RecoveryObjectStorageDriver", recovery)
        self.assertIn("driveDriver:RecoveryGoogleDriveDriver", recovery)
        self.assertIn("databaseDriver:RecoveryDatabaseDriver", recovery)
        docs = read("docs/recovery-runtime-e2e.md")
        self.assertIn("Todos los drivers son fakes inyectados", docs)
        self.assertIn("No hay red", docs)
        fixture = json.dumps({
            "gaps": sorted(GAPS), "stage": "offline",
            "authority": "unchanged", "secrets": False,
        })
        self.assertNotIn("Bearer ", fixture)
        self.assertNotIn("password=", fixture)

    def test_estados_unknown_explicitos(self):
        """AC-04: la evidencia sintética no certifica proveedores ni live."""
        for identifier, reason in EXTERNAL_GAPS.items():
            with self.subTest(identifier=identifier):
                self.assertTrue(reason.endswith("_unobserved"))
                for alleged in (
                    None, {}, {"status": "success"},
                    {"authority": "live", "validated": True},
                    {"source": "fake", "evidence": "GREEN"},
                ):
                    self.assertEqual(
                        offline_status(identifier, alleged_evidence=alleged),
                        UNKNOWN,
                    )
        self.assertIn("sin go-live", read("README.md"))
        self.assertIn("Prueba sólo fake", row_for("RT-05")[3])
        self.assertIn("autorización operacional", row_for("RM-14")[3])
        self.assertIn("no se eluden controles externos", row_for("RM-13")[3])


if __name__ == "__main__":
    unittest.main()
