"""Contrato local GET-only para el caller FactoryRunner de Factory #1382."""

from pathlib import Path
import re
import unittest


CALLER = (
    Path(__file__).resolve().parents[1]
    / ".github"
    / "workflows"
    / "observador-reservas-consumidor.yml"
)
REUSABLE = "pl0n3r/factory/.github/workflows/observador-reservas-consumidor.yml@v1"
PERMISSIONS = ("contents", "issues", "pull-requests", "checks", "actions")


def _read_caller() -> str:
    return CALLER.read_text(encoding="utf-8")


def _safe_get_only_contract(source: str) -> bool:
    root = "permissions:\n" + "".join(f"  {name}: read\n" for name in PERMISSIONS)
    job = "    permissions:\n" + "".join(
        f"      {name}: read\n" for name in PERMISSIONS
    )
    privileged = (
        r"(?m)^  (?:push|pull_request|pull_request_target|issues|"
        r"issue_comment|workflow_run|repository_dispatch|workflow_call|merge_group):"
    )
    return (
        source.count("\non:\n") == 1
        and "  schedule:\n    - cron: '*/10 * * * *'\n" in source
        and "  workflow_dispatch:\n" in source
        and re.search(privileged, source) is None
        and root in source
        and job in source
        and len(re.findall(
            r"(?m)^\s*(?:contents|issues|pull-requests|checks|actions): "
            r"(?:read|write)$", source
        )) == 10
        and re.search(r"(?m):\s*write\s*$", source) is None
        and "group: lease-consumer-caller-${{ github.repository_id }}" in source
        and "cancel-in-progress: false" in source
        and source.count(f"uses: {REUSABLE}") == 1
        and source.count("uses:") == 1
        and "secrets:" not in source
        and "FACTORY_LEASE_AUTO_RELEASE_ENABLED" not in source
        and re.search(r"(?m)^\s*(?:steps|run):", source) is None
    )


class LeaseObserverCallerTests(unittest.TestCase):
    def test_schedule_dispatch_and_local_v1_reference(self) -> None:
        source = _read_caller()
        self.assertIn("  schedule:\n    - cron: '*/10 * * * *'\n", source)
        self.assertIn("  workflow_dispatch:\n", source)
        self.assertEqual(source.count(f"uses: {REUSABLE}"), 1)
        self.assertEqual(source.count("uses:"), 1)
        self.assertTrue(_safe_get_only_contract(source))

    def test_read_only_permissions_and_local_concurrency(self) -> None:
        source = _read_caller()
        for name in PERMISSIONS:
            self.assertIn(f"  {name}: read\n", source)
            self.assertIn(f"      {name}: read\n", source)
        self.assertIn("lease-consumer-caller-${{ github.repository_id }}", source)
        self.assertIn("cancel-in-progress: false", source)
        self.assertNotIn("secrets:", source)
        self.assertNotIn("FACTORY_LEASE_AUTO_RELEASE_ENABLED", source)
        self.assertNotRegex(source, r"(?m):\s*write\s*$")
        self.assertTrue(_safe_get_only_contract(source))

    def test_reject_privileged_events_and_mutation_paths(self) -> None:
        source = _read_caller()
        self.assertTrue(_safe_get_only_contract(source))
        unsafe = (
            source.replace("  issues: read\n", "  issues: write\n", 1),
            source.replace("  workflow_dispatch:\n",
                           "  pull_request_target:\n  workflow_dispatch:\n", 1),
            source.replace("@v1", "@main", 1),
            source.replace("cancel-in-progress: false",
                           "cancel-in-progress: true", 1),
            source + "\nsecrets: inherit\n",
            source + "\nFACTORY_LEASE_AUTO_RELEASE_ENABLED: 'true'\n",
            source + "\n    steps:\n      - run: echo bad\n",
        )
        for scenario in unsafe:
            with self.subTest(mutation=scenario[-100:]):
                self.assertFalse(_safe_get_only_contract(scenario))


if __name__ == "__main__":
    unittest.main()
