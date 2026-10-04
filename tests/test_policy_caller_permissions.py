#!/usr/bin/env python3
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALLER = ROOT / ".github/workflows/politica.yml"


def _mapping_block(lines: list[str], header: str, indent: int) -> dict[str, str]:
    prefix = " " * indent + header
    try:
        start = lines.index(prefix) + 1
    except ValueError as exc:
        raise AssertionError(f"Falta bloque {header}") from exc

    result: dict[str, str] = {}
    for line in lines[start:]:
        if not line.strip():
            continue
        current_indent = len(line) - len(line.lstrip(" "))
        if current_indent <= indent:
            break
        if current_indent != indent + 2 or ":" not in line:
            continue
        key, value = line.strip().split(":", 1)
        result[key.strip()] = value.strip()
    return result


class PolicyCallerPermissionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = CALLER.read_text(encoding="utf-8")
        self.lines = self.text.splitlines()

    def _policy_job(self) -> str:
        job = self.text.split("  politica:\n", 1)[1]
        return job

    def test_policy_caller_keeps_legacy_minimal_permissions(self) -> None:
        self.assertEqual(
            {
                "contents": "read",
                "pull-requests": "read",
            },
            _mapping_block(self.lines, "permissions:", 0),
        )
        self.assertNotIn("    permissions:", self._policy_job())
        self.assertEqual(1, self.text.count("permissions:"))
        self.assertNotIn("issues: write", self.text)
        self.assertNotIn("checks: read", self.text)

    def test_policy_caller_does_not_expand_permissions(self) -> None:
        write_lines = [
            line.strip()
            for line in self.lines
            if line.strip().endswith(": write")
        ]
        self.assertEqual([], write_lines)
        for forbidden in (
            "actions: write",
            "checks: write",
            "contents: write",
            "deployments: write",
            "id-token: write",
            "issues: write",
            "packages: write",
            "pull-requests: write",
            "security-events: write",
        ):
            self.assertNotIn(forbidden, self.text)

    def test_policy_caller_keeps_factory_v1_and_existing_contract(self) -> None:
        self.assertIn(
            "uses: pl0n3r/factory/.github/workflows/politica.yml@v1",
            self.text,
        )
        self.assertIn("types: [opened, synchronize, reopened, edited]", self.text)
        self.assertIn("pr_number: ${{ github.event.pull_request.number }}", self.text)
        self.assertEqual(1, self.text.count("uses: "))


if __name__ == "__main__":
    unittest.main()
