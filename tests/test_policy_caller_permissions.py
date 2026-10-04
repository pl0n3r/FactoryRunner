#!/usr/bin/env python3
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALLER = ROOT / ".github/workflows/politica.yml"


class PolicyCallerPermissionsTests(unittest.TestCase):
    def _text(self) -> str:
        return CALLER.read_text(encoding="utf-8")

    def _job_permissions(self) -> dict[str, str]:
        job = self._text().split("  politica:\n", 1)[1]
        match = re.search(
            r"^    permissions:\n(?P<body>(?:^      [a-z-]+: [a-z]+\n)+)",
            job,
            flags=re.MULTILINE,
        )
        self.assertIsNotNone(match)
        assert match is not None
        return {
            key: value
            for key, value in (
                line.strip().split(": ", 1)
                for line in match.group("body").splitlines()
            )
        }

    def test_policy_caller_grants_exact_reusable_permissions(self) -> None:
        self.assertEqual(
            self._job_permissions(),
            {
                "contents": "read",
                "pull-requests": "read",
                "issues": "write",
                "checks": "read",
            },
        )

    def test_policy_caller_does_not_expand_other_permissions(self) -> None:
        text = self._text()
        top = text.split("jobs:", 1)[0]
        self.assertIn("permissions:\n  contents: read\n  pull-requests: read", top)
        for forbidden in (
            "contents: write",
            "pull-requests: write",
            "actions: write",
            "packages: write",
            "id-token: write",
        ):
            self.assertNotIn(forbidden, text)

    def test_policy_caller_keeps_factory_v1_and_existing_contract(self) -> None:
        text = self._text()
        self.assertIn(
            "uses: pl0n3r/factory/.github/workflows/politica.yml@v1",
            text,
        )
        self.assertIn("types: [opened, synchronize, reopened, edited]", text)


if __name__ == "__main__":
    unittest.main()
