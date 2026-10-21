"""Regresiones offline de privacidad documental, con Factory@v1 fijado.

Los hashes Git de documentos esperados se obtuvieron del render canónico
Factory@v1 con el datos.yml de FactoryRunner; no autorizan revisión jurídica.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = (
    "aviso-privacidad.md", "canal-derechos.md", "politica-tratamiento.md",
    "registro-tratamientos.md", "retencion.md", "terminos-condiciones.md",
)
EXPECTED_GENERATED_BLOBS = {
    "canal-derechos.md": "e66ecda2039998736b2ffda6be340c0c75ddc821",
    "politica-tratamiento.md": "8e098ac8013180dbf38c339efd2333bf30e7503c",
}


def blob_sha(content: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


class PrivacyTemplateSyncTests(unittest.TestCase):
    def test_generated_sources_exact(self):
        for filename in SOURCES:
            with self.subTest(filename=filename):
                original = (ROOT / "docs" / "privacidad" / filename).read_bytes()
                replica = (ROOT / "revision-juridica" / filename).read_bytes()
                self.assertEqual(original, replica)
                if filename in EXPECTED_GENERATED_BLOBS:
                    self.assertEqual(blob_sha(original), EXPECTED_GENERATED_BLOBS[filename])
        canal = (ROOT / "docs/privacidad/canal-derechos.md").read_text(encoding="utf-8")
        policy = (ROOT / "docs/privacidad/politica-tratamiento.md").read_text(encoding="utf-8")
        self.assertIn("portabilidad", canal)
        self.assertIn("verificación de identidad", policy)

    def test_revision_bundle_current(self):
        completed = subprocess.run(
            [sys.executable, "scripts/generar_revision_juridica.py", "--check"],
            cwd=ROOT, capture_output=True, text=True, timeout=25, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Paquete jurídico sincronizado", completed.stdout)

    def test_no_legal_approval(self):
        data = json.loads((ROOT / "datos.yml").read_text(encoding="utf-8"))
        self.assertEqual(data["phase"], "construccion")
        self.assertEqual(data["project"], "pl0n3r/FactoryRunner")
        self.assertTrue(all(value == "[COMPLETAR POR EL DUEÑO]" for value in data["controller"].values()))
        self.assertTrue(all(
            all(row[field] == "review_required" for field in ("basis", "consent", "retention"))
            for row in data["treatments"]
        ))
        for filename in ("00-LEEME.md", "paquete-completo.md"):
            text = (ROOT / "revision-juridica" / filename).read_text(encoding="utf-8")
            self.assertIn("documented_not_legally_approved", text)
        self.assertIn("No autorizan go-live", (ROOT / "revision-juridica/00-LEEME.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
