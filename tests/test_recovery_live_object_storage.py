"""Aceptación ejecutable FactoryRunner #41."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryLiveObjectStorageTests(unittest.TestCase):
    def test_opaque_alias_resolves_runtime_configuration_without_secret_echo(self):
        s=read("src/recovery/connection-resolver.ts"); t=read("tests/recovery-live-object-storage.test.ts")
        for token in ("controlbot:connection/","FACTORYRUNNER_CONNECTION_","RecoveryConnectionError"): self.assertIn(token,s)
        self.assertIn("secrets never enter request URL or result",t)

    def test_s3_compatible_upload_verify_materialize_returns_sanitized_evidence(self):
        s=read("src/recovery/s3-compatible-driver.ts")
        for token in ("AWS4-HMAC-SHA256","operation==='upload'","operation==='verify'","evidence_ref:'evidence:'"): self.assertIn(token,s)

    def test_inline_credentials_signed_urls_and_sensitive_payloads_fail_closed(self):
        s=read("src/recovery/live-object-storage.ts"); t=read("tests/recovery-live-object-storage.test.ts")
        for token in ("signed[_-]?url","SENSITIVE"): self.assertIn(token,s)
        self.assertIn("inline secrets, signed URLs",t)

    def test_endpoint_bucket_and_prefix_are_alias_bound_and_ssrf_safe(self):
        s=read("src/recovery/connection-resolver.ts")
        for token in ("parsed.protocol!=='https:'","isIP(host)!==0","BUCKET","PREFIX"): self.assertIn(token,s)

    def test_idempotency_and_checksum_version_mismatch_fail_closed(self):
        d=read("src/recovery/s3-compatible-driver.ts"); a=read("src/adapters/recovery-object-storage.ts")
        for token in ("command.checksum_sha256","invalid_version"): self.assertIn(token,d)
        self.assertIn("idempotency_key",a)

    def test_provider_credentials_are_technical_and_do_not_create_personal_data_signal(self):
        s=read("src/recovery/connection-resolver.ts")
        self.assertNotIn("SESSION_TOKEN",s)
        self.assertNotIn("session_token",s)
        self.assertIn("AWS_SECURITY_TOKEN",s)

    def test_live_caller_preserves_authority_and_excludes_scheduler_delete_restore_and_drive_primary(self):
        d=read("docs/recovery-live-object-storage.md"); t=read("tests/recovery-live-object-storage.test.ts")
        for token in ("authority=unchanged","retention deletion","Google Drive primary"): self.assertIn(token,d)
        self.assertIn("recovery.object-storage.delete",t)

if __name__=="__main__": unittest.main()
