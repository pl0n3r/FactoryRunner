import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class FactoryCoordinationAdoptionTests(unittest.TestCase):
    def test_caller_uses_factory_v1_spanish_profile_only(self):
        text = (ROOT / ".github/workflows/work-coordination.yml").read_text(encoding="utf-8")
        self.assertIn("pl0n3r/factory/.github/workflows/coordinacion.yml@v1", text)
        self.assertIn("profile: es", text)
        self.assertNotIn("@main", text)
        self.assertNotIn("coordinar_trabajo.py", text)
        self.assertIn("startsWith(github.event.pull_request.head.ref, 'factory/bootstrap-coordination-')", text)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", text)
        self.assertIn("github.event.pull_request.author_association == 'OWNER'", text)
        self.assertIn("require_reservation: true", text)

    def test_caller_keeps_hardened_consumer_coordination_contract(self):
        text = (ROOT / ".github/workflows/work-coordination.yml").read_text(encoding="utf-8")
        self.assertIn("types: [opened, reopened, synchronize, edited, ready_for_review, converted_to_draft, closed]", text)
        self.assertIn("group: coordinacion-${{ github.repository }}", text)
        self.assertIn("cancel-in-progress: false", text)
        self.assertIn("queue: max", text)
        comment = text.split("  comentario:", 1)[1].split("  etiqueta:", 1)[0]
        self.assertIn("github.event.comment.body == '/tomar'", comment)
        self.assertIn("contains(github.event.comment.body, '/tomar')", comment)
        self.assertIn("startsWith(github.event.comment.body, '/renovar-contrato ')", comment)
        routes = {
            "comentario": "operation: comment",
            "etiqueta": "operation: label",
            "pr": "operation: pr",
            "validar-pr": "operation: validate",
            "issue": "operation: issue",
            "sweep": "operation: sweep",
        }
        names = list(routes)
        for index, name in enumerate(names):
            tail = text.split(f"  {name}:", 1)[1]
            block = tail.split(f"  {names[index + 1]}:", 1)[0] if index + 1 < len(names) else tail
            self.assertIn(routes[name], block)
