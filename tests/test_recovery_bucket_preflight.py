"""Aceptación ejecutable FactoryRunner #47."""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS_TEST = ROOT / "tests/recovery-live-object-storage.test.ts"
DRIVER = ROOT / "src/recovery/s3-compatible-driver.ts"
DOC = ROOT / "docs/recovery-live-object-storage.md"

class RecoveryBucketPreflightTests(unittest.TestCase):
    def node_test(self, pattern: str) -> None:
        result = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--test",
                f"--test-name-pattern={pattern}",
                str(TS_TEST),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_enabled_versioning_and_object_lock_allow_object_operation(self) -> None:
        self.node_test("enabled versioning and Object Lock allow object operation")

    def test_missing_suspended_or_unknown_versioning_fails_closed(self) -> None:
        self.node_test("missing suspended or unknown versioning fails closed before object operation")

    def test_nested_status_is_not_direct_versioning_child(self) -> None:
        self.node_test("nested Status under unknown element fails versioning before object operation")

    def test_nested_lock_enabled_is_not_direct_object_lock_child(self) -> None:
        self.node_test("nested ObjectLockEnabled under unknown element fails before object operation")

    def test_missing_disabled_or_unknown_object_lock_fails_closed(self) -> None:
        self.node_test("missing disabled or unknown Object Lock fails closed before object operation")

    def test_invalid_xml_http_errors_and_unsupported_provider_are_generic_failures(self) -> None:
        self.node_test("invalid XML HTTP errors and unsupported provider are generic failures")

    def test_preflight_is_instance_scoped_and_never_persisted(self) -> None:
        self.node_test("bucket preflight is cached per driver instance and never persisted")

    def test_driver_remains_provider_agnostic(self) -> None:
        source = DRIVER.read_text(encoding="utf-8")
        for provider in (
            "Backblaze", "backblaze", "B2", "Amazon", "amazonaws.com"
        ):
            self.assertNotIn(provider, source)
        compact = re.sub(r"\\s+", " ", source)
        for branch in (
            r"(?i)\\b(?:if|switch)\\s*\\([^)]*['\"]AWS['\"][^)]*\\)",
            r"(?i)\\bcase\\s+['\"]AWS['\"]",
            r"(?i)\\b(?:provider|vendor|backend)\\s*[:=]{1,3}\\s*['\"]AWS['\"]",
        ):
            self.assertNotRegex(compact, branch)
        self.assertIn("AWS4-HMAC-SHA256", source)
        self.assertIn("versioning", source)
        self.assertIn("object-lock", source)
        self.assertIn("S3-compatible", DOC.read_text(encoding="utf-8"))

    def test_object_lock_contract_and_sanitized_evidence_remain_intact(self) -> None:
        source = DRIVER.read_text(encoding="utf-8")
        for token in (
            "x-amz-version-id",
            "x-amz-object-lock-mode",
            "COMPLIANCE",
            "x-amz-object-lock-retain-until-date",
            "immutable_version_ref",
            "evidence_ref",
        ):
            self.assertIn(token, source)
        self.node_test("version without Object Lock compliance fails closed")

if __name__ == "__main__":
    unittest.main()
