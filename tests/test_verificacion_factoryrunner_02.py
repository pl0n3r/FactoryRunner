"""FactoryRunner #694: 13 testigos sin convertir evidencia offline en go-live.

Ejecuta contratos TypeScript productivos con drivers de prueba; NO usa endpoints,
credenciales ni datos reales y NO modifica docs/matriz-cobertura.md.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs/verificacion/verificacion-02.md"
# ID, estado auditado, clase, origen, suite de testigo y método/caso exacto.
ROWS = (
    ("LO-07", "NO_VERIFICABLE", "B", "docs/recovery-live-object-storage.md", "tests/recovery-live-object-storage.test.ts", "missing suspended or unknown versioning fails closed before object operation"),
    ("RT-05", "NO_VERIFICABLE", "B", "docs/recovery-runtime-e2e.md", "tests/recovery-runtime-e2e.test.ts", "cross-provider and cross-capability inputs fail closed before fake drivers run"),
    ("KS-04", "NO_VERIFICABLE", "B", "docs/runner-kill-switch-rehearsal.md", "tests/kill-switch-rollback-rehearsal.test.ts", "AC-01 tras el kill switch no se aceptan ejecuciones nuevas"),
    ("I465-01", "SIN_COBERTURA", "D", "FactoryRunner#465", "tests/go-live-preflight.test.ts", "reports cannot elevate live authority regardless of gate combinations"),
    ("I465-03", "SIN_COBERTURA", "D", "FactoryRunner#465", "tests/controlbot-health-contract.test.ts", "unsigned, malformed, changed or untrusted evidence fails closed"),
    ("PA-01", "NO_VERIFICABLE", "C", "docs/privacidad/aviso-privacidad.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PA-02", "NO_VERIFICABLE", "B", "docs/privacidad/aviso-privacidad.md", "tests/go-live-preflight.test.ts", "all offline proofs enable preparation but never operation"),
    ("PC-01", "NO_VERIFICABLE", "C", "docs/privacidad/canal-derechos.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PP-01", "NO_VERIFICABLE", "C", "docs/privacidad/politica-tratamiento.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PRG-01", "NO_VERIFICABLE", "C", "docs/privacidad/registro-tratamientos.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PRT-01", "NO_VERIFICABLE", "C", "docs/privacidad/retencion.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PTC-01", "NO_VERIFICABLE", "C", "docs/privacidad/terminos-condiciones.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
    ("PTC-02", "NO_VERIFICABLE", "C", "docs/privacidad/terminos-condiciones.md", "tests/test_cobertura_factoryrunner_01.py", "CoberturaFactoryrunner01Tests.test_contrato_principal"),
)
TS_SUITES = (
    "tests/recovery-live-object-storage.test.ts",
    "tests/recovery-runtime-e2e.test.ts",
    "tests/kill-switch-rollback-rehearsal.test.ts",
    "tests/go-live-preflight.test.ts",
    "tests/controlbot-health-contract.test.ts",
)


class VerificacionFactoryrunner02Tests(unittest.TestCase):
    def test_inventario_de_13_filas_y_brechas_no_promovidas(self):
        self.assertEqual(len(ROWS), 13)
        ids = [row[0] for row in ROWS]
        self.assertEqual(len(set(ids)), 13)
        self.assertEqual(sum(row[1] == "SIN_COBERTURA" for row in ROWS), 2)
        self.assertEqual(sum(row[1] == "NO_VERIFICABLE" for row in ROWS), 11)
        report = REPORT.read_text(encoding="utf-8")
        report_ids = re.findall(r"(?m)^\| \x60([A-Z0-9-]+)\x60 \|", report)
        self.assertEqual(report_ids, ids)
        self.assertIn("0 promociones", report)
        self.assertIn("#606", report)
        self.assertIn("#605", report)
        for row_id, state, kind, source, witness, test in ROWS:
            with self.subTest(row=row_id):
                line = next(line for line in report.splitlines()
                            if line.startswith("| \x60" + row_id + "\x60 |"))
                for expected in (state, kind, source, witness, test):
                    self.assertIn(expected, line)
                self.assertNotIn("| CUBIERTO |", line)

    def test_testigos_existen_y_tienen_aserciones_sobre_modulos_reales(self):
        for row_id, _, _, _, file, title in ROWS:
            with self.subTest(row=row_id):
                source = (ROOT / file).read_text(encoding="utf-8")
                if file.endswith(".ts"):
                    self.assertIn("test('" + title + "'", source)
                    self.assertIn("assert.", source)
                    self.assertRegex(source, r"\.\./(?:src|scripts)/")
                else:
                    self.assertIn("class CoberturaFactoryrunner01Tests", source)
                    self.assertIn("def test_contrato_principal", source)

    def test_suites_ts_ejecutan_regresiones_de_negativos_y_seguridades(self):
        """Los testigos TS verifican comportamiento, no solo texto del README."""
        node = shutil.which("node")
        self.assertIsNotNone(node, "Se requiere Node 24; no omitir testigos")
        runner = subprocess.run(
            [node, "--experimental-strip-types", "--test", *TS_SUITES],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=180,
        )
        self.assertEqual(
            runner.returncode, 0,
            "Contratos TypeScript fallaron:\n"
            + (runner.stdout + "\n" + runner.stderr)[-9000:],
        )
        for row_id, _, _, _, file, title in ROWS:
            if file not in TS_SUITES:
                continue
            with self.subTest(row=row_id):
                self.assertIn(" - " + title, runner.stdout)

    def test_preflight_y_observador_jamas_acreditan_live(self):
        code = (ROOT / "src/go-live-preflight.ts").read_text(encoding="utf-8")
        self.assertIn("live_authorized: false as const", code)
        self.assertIn("readiness: 'UNKNOWN' as const", code)
        runbook = (ROOT / "docs/go-live-preflight.md").read_text(encoding="utf-8")
        self.assertIn("live_authorized=false", runbook)
        self.assertIn("readiness=UNKNOWN", runbook)
        self.assertIn("No se inicia observación real", REPORT.read_text(encoding="utf-8"))

    def test_documentos_juridicos_se_mantienen_pendientes_sin_inventar_datos(self):
        data = json.loads((ROOT / "datos.yml").read_text(encoding="utf-8"))
        self.assertEqual(data["phase"], "construccion")
        controller = data["controller"]
        self.assertTrue(all(
            "[COMPLETAR POR EL DUEÑO]" in controller[k]
            for k in ("name", "identifier", "address", "rights_email")
        ))
        treatment = next(t for t in data["treatments"]
                         if t["id"] == "runner_location_metadata")
        for field in ("basis", "retention", "consent"):
            self.assertEqual(treatment[field], "review_required")
        self.assertEqual(treatment["providers"], [])
        privacy_docs = (
            "aviso-privacidad.md", "canal-derechos.md",
            "politica-tratamiento.md", "registro-tratamientos.md",
            "retencion.md", "terminos-condiciones.md",
        )
        for name in privacy_docs:
            with self.subTest(document=name):
                body = (ROOT / "docs/privacidad" / name).read_text(encoding="utf-8")
                self.assertIn("revisión jurídica", body.lower())
                self.assertTrue(
                    "[COMPLETAR POR EL DUEÑO]" in body or "review_required" in body
                )
        aviso = (ROOT / "docs/privacidad/aviso-privacidad.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("casilla no premarcada", aviso)
        self.assertIn("no acredita que exista consentimiento", aviso.lower())


if __name__ == "__main__":
    unittest.main()
