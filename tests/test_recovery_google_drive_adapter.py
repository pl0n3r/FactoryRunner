"""Aceptación ejecutable FactoryRunner #31."""
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryGoogleDriveAdapterTests(unittest.TestCase):
    def test_google_drive_descriptor_and_capability_contract(self):
        source=read("src/adapters/recovery-google-drive.ts")
        tests=read("tests/recovery-google-drive-adapter.test.ts")
        self.assertIn("raw.provider!=='google_drive'",source)
        self.assertIn("raw.role!=='cold_copy'",source)
        self.assertIn("Capability y operation no coinciden",source)
        self.assertIn("descriptor is cold-copy",tests)

    def test_driver_boundary_rejects_oauth_service_account_urls_and_extra_fields(self):
        source=read("src/adapters/recovery-google-drive.ts")
        tests=read("tests/recovery-google-drive-adapter.test.ts")
        self.assertIn("controlbot:connection/",source)
        self.assertIn("CREDENTIAL_WORDS",source)
        for term in ("oauth_token","service_account","shared_url","provider_payload"):
            self.assertIn(term,tests)

    def test_result_requires_matching_object_checksum_and_safe_remote_evidence(self):
        source=read("src/adapters/recovery-google-drive.ts")
        self.assertIn("objectRef!==command.object_ref",source)
        self.assertIn("digest!==command.checksum_sha256",source)
        self.assertIn("remote_version_ref",source)
        self.assertIn("evidence_ref",source)

    def test_fingerprint_idempotency_and_cold_copy_role_contract(self):
        source=read("src/adapters/recovery-google-drive.ts")
        tests=read("tests/recovery-google-drive-adapter.test.ts")
        self.assertIn("stableSha256(canonical)!==descriptorId",source)
        self.assertIn("idempotency_key",source)
        self.assertIn("primary_offsite",tests)

    def test_driver_failures_are_generic_and_authority_is_unchanged(self):
        source=read("src/adapters/recovery-google-drive.ts")
        tests=read("tests/recovery-google-drive-adapter.test.ts")
        self.assertIn("recovery_google_drive_failed",source)
        self.assertIn("raw.authority!=='unchanged'",source)
        self.assertIn("driver errors are generic",tests)

    def test_adapter_is_exported_and_node_suite_covers_injected_driver(self):
        index=read("src/index.ts")
        package=json.loads(read("package.json"))
        self.assertIn("RecoveryGoogleDriveAdapter",index)
        self.assertIn("RecoveryGoogleDriveDriver",read("src/adapters/recovery-google-drive.ts"))
        self.assertIn("tests/*.test.ts",package["scripts"]["test"])
        self.assertIn("network/provider implementations stay outside",read("tests/recovery-google-drive-adapter.test.ts"))

if __name__=="__main__": unittest.main()
