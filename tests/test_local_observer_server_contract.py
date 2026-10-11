"""Acceptance contract for #468: offline, HTTP only to 127.0.0.1."""
from __future__ import annotations

from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "local-observer-server.test.ts"


class LocalObserverServerContractTests(unittest.TestCase):
    def _check(self, name: str) -> None:
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test",
             "--test-reporter=tap", "--test-name-pattern", name, str(SUITE)],
            cwd=ROOT, text=True, capture_output=True, check=False, timeout=35,
        )
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output[-4000:])
        self.assertIn("pass 1", result.stdout, output[-4000:])

    def test_loopback_get_only_without_external_network(self):
        self._check("AC01")

    def test_reject_remote_bind_and_methods_fail_closed(self):
        self._check("AC02")

    def test_refuse_untrusted_snapshot_and_never_execute_orders(self):
        self._check("AC03")

    def test_exact_loopback_host_origin_and_no_cors_rebinding(self):
        self._check("AC04")


if __name__ == "__main__":
    unittest.main()
