"""Regresión de enrutamiento seguro del recuperador CAS V3 en FactoryRunner."""

from pathlib import Path
import unittest


SOURCE = (
    Path(__file__).resolve().parents[1]
    / ".github"
    / "workflows"
    / "coordinacion.yml"
)
PREFIX = "/recuperar-lock-v3-activa "


class CoordinationLockRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.job = cls.source.split("\n  comentario:\n", 1)[1].split(
            "\n  etiqueta:\n", 1
        )[0]
        cls.guard = cls.job.split("    # El reusable", 1)[0]

    def test_solo_issue_comment_y_autor_identico(self):
        self.assertIn("github.event_name == 'issue_comment'", self.guard)
        self.assertIn("github.event.issue.pull_request == null", self.guard)
        self.assertIn(
            "github.event.sender.login == github.event.comment.user.login",
            self.guard,
        )
        self.assertEqual(
            1,
            self.guard.count(
                "startsWith(github.event.comment.body, "
                "'/recuperar-lock-v3-activa ')"
            ),
        )
        self.assertNotIn(
            "contains(github.event.comment.body, '/recuperar-lock-v3-activa",
            self.source,
        )

    def test_negativos_del_prefijo_del_caller(self):
        valid = PREFIX + "a" * 40 + " 11111111-1111-4111-8111-111111111111"
        for body in (
            "other text " + valid,
            "\n" + valid,
            "quote: " + valid,
            "/recuperar-lock-v3-activa",
            "/RECUPERAR-LOCK-V3-ACTIVA " + "a" * 40,
        ):
            with self.subTest(body=body[:30]):
                self.assertFalse(body.startswith(PREFIX))
        self.assertTrue(valid.startswith(PREFIX))

    def test_delegacion_sin_mutacion_directa(self):
        self.assertIn(
            "uses: pl0n3r/factory/.github/workflows/coordinacion.yml@v1",
            self.job,
        )
        for field in (
            "operation: comment",
            "issue_number: " + chr(36) + "{{ github.event.issue.number }}",
            "actor: " + chr(36) + "{{ github.event.comment.user.login }}",
            "association: " + chr(36) + "{{ github.event.comment.author_association }}",
            "body: " + chr(36) + "{{ github.event.comment.body }}",
        ):
            with self.subTest(field=field):
                self.assertIn(field, self.job)
        self.assertNotIn("gh api --method DELETE", self.job)
        self.assertNotIn("git push --force", self.job)

    def test_sin_escalar_permisos_ni_reemplazar_comandos(self):
        preamble = self.source.split("\njobs:\n", 1)[0]
        self.assertIn("permissions:\n  contents: read\n", preamble)
        self.assertNotIn("contents: write", preamble)
        for old in (
            "github.event.comment.body == '/tomar'",
            "github.event.comment.body == '/liberar-forzado'",
            "startsWith(github.event.comment.body, '/renovar-contrato ')",
        ):
            with self.subTest(old=old):
                self.assertIn(old, self.guard)
        for permission in (
            "contents: write",
            "issues: write",
            "pull-requests: write",
            "checks: write",
        ):
            self.assertIn(permission, self.job)


if __name__ == "__main__":
    unittest.main()
