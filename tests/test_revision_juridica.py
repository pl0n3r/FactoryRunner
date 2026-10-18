"""Contrato reproducible del paquete jurídico FactoryRunner #573."""
from __future__ import annotations
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import scripts.generar_revision_juridica as generator
from scripts.generar_revision_juridica import tree_sha

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "revision-juridica"
SOURCE = ROOT / "docs" / "privacidad"
NAMES = (
    "aviso-privacidad.md", "canal-derechos.md", "politica-tratamiento.md",
    "registro-tratamientos.md", "retencion.md", "terminos-condiciones.md",
)

class RevisionJuridicaTests(unittest.TestCase):
    def test_current_repo_bundle_is_in_sync(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/generar_revision_juridica.py", "--check"],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(
            {"00-LEEME.md", "paquete-completo.md", *NAMES},
            {p.name for p in OUT.iterdir()},
        )
        pack = (OUT / "paquete-completo.md").read_bytes()
        positions = []
        for name in NAMES:
            with self.subTest(name=name):
                source = (SOURCE / name).read_bytes()
                self.assertEqual(source, (OUT / name).read_bytes())
                header = ("## Fuente: docs/privacidad/" + name + "\n\n").encode()
                self.assertEqual(1, pack.count(header))
                start = pack.index(header) + len(header)
                self.assertEqual(source, pack[start:start + len(source)])
                positions.append(start)
        self.assertEqual(positions, sorted(positions))

    def test_index_keeps_legal_review_pending(self) -> None:
        readme = (OUT / "00-LEEME.md").read_text(encoding="utf-8")
        self.assertIn("Última actualización automática:", readme.splitlines()[0])
        self.assertIn("SHA de origen", readme.splitlines()[0])
        self.assertIn("documented_not_legally_approved", readme)
        self.assertIn("- [ ] Razón social", readme)
        self.assertIn("- [ ] Dirección física", readme)
        self.assertIn("- [ ] Contacto", readme)
        self.assertIn("Proveedores declarados: ninguno declarado", readme)
        self.assertIn("Hostinger", readme)
        self.assertIn("no demuestra", readme)

    def test_source_sha_refuses_uncommitted_legal_edits(self) -> None:
        current = tree_sha()
        self.assertEqual(
            current,
            (OUT / "00-LEEME.md").read_text(encoding="utf-8").splitlines()[0][-40:],
        )
        with patch("scripts.generar_revision_juridica.subprocess.run") as runner:
            runner.return_value.returncode = 1
            with self.assertRaisesRegex(ValueError, "sin commit"):
                tree_sha()
            self.assertEqual("diff", runner.call_args.args[0][1])

    def test_missing_or_invalid_index_is_drift_after_source_validation(self) -> None:
        valid_sha = "a" * 40
        cases = (
            None, b"", b"not an index\n", b"\xff",
            f"Última actualización automática: 2026-02-30 UTC · SHA de origen de docs/privacidad: {valid_sha}\n".encode(),
        )
        for contents in cases:
            with self.subTest(index=repr(contents)), tempfile.TemporaryDirectory() as scratch:
                output = Path(scratch)
                if contents is not None:
                    (output / "00-LEEME.md").write_bytes(contents)
                with patch.object(generator, "OUT", output), patch.object(
                    generator, "expected_files", return_value={"00-LEEME.md": b"expected"}
                ) as verify_sources:
                    self.assertEqual(1, generator.run(check=True))
                    verify_sources.assert_called_once()

    def test_missing_index_does_not_mask_source_verification_errors(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            with patch.object(generator, "OUT", Path(scratch)), patch.object(
                generator, "expected_files", side_effect=ValueError("source not valid")
            ):
                self.assertEqual(2, generator.run(check=True))

    def test_workflow_uses_minimum_permissions_and_sync_trigger(self) -> None:
        workflow = (ROOT / ".github/workflows/revision-juridica-sync.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("branches: [main]", workflow)
        self.assertIn("docs/privacidad/**", workflow)
        self.assertIn("revision-juridica/**", workflow)
        self.assertIn("scripts/generar_revision_juridica.py", workflow)
        self.assertIn('case "$status" in', workflow)
        self.assertIn("schedule:", workflow)
        self.assertIn("cron:", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("issues: write", workflow)
        self.assertNotIn("contents: write", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertIn("generar_revision_juridica.py --check", workflow)
        self.assertIn("revision-juridica-desfase", workflow)
        self.assertIn("issues?state=open", workflow)
        self.assertIn("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", workflow)

if __name__ == "__main__":
    unittest.main()
