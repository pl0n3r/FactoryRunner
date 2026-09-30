"""Aceptación ejecutable FactoryRunner #45."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryObjectLockTests(unittest.TestCase):
    def test_version_without_compliance_lock_fails_closed(self):
        driver=read("src/recovery/s3-compatible-driver.ts")
        tests=read("tests/recovery-live-object-storage.test.ts")
        self.assertIn("x-amz-object-lock-mode",driver)
        self.assertIn("!=='COMPLIANCE'",driver)
        self.assertIn("version without Object Lock compliance fails closed",tests)

    def test_upload_requests_and_verifies_compliance_retention(self):
        resolver=read("src/recovery/connection-resolver.ts")
        driver=read("src/recovery/s3-compatible-driver.ts")
        tests=read("tests/recovery-live-object-storage.test.ts")
        self.assertIn("OBJECT_LOCK_DAYS",resolver)
        for token in ("'x-amz-object-lock-mode':'COMPLIANCE'","'x-amz-object-lock-retain-until-date':retainUntil","await this.#headImmutable"):
            self.assertIn(token,driver)
        self.assertIn("['HEAD','PUT','HEAD']",tests)

    def test_verify_requires_checksum_version_and_future_retention(self):
        driver=read("src/recovery/s3-compatible-driver.ts")
        for token in ("x-amz-meta-sha256","x-amz-version-id","futureRetention","timestamp<=now.getTime()"):
            self.assertIn(token,driver)
        self.assertIn("return this.#ok(command,await this.#headImmutable",driver)

    def test_materialize_requires_same_verified_version(self):
        driver=read("src/recovery/s3-compatible-driver.ts")
        tests=read("tests/recovery-live-object-storage.test.ts")
        self.assertIn("const verifiedVersion=await this.#headImmutable",driver)
        self.assertIn("getVersion!==verifiedVersion",driver)
        self.assertIn("materialize requires GET to match the immutable HEAD version and checksum",tests)

    def test_invalid_or_expired_object_lock_is_generic_failure(self):
        resolver=read("src/recovery/connection-resolver.ts")
        caller=read("src/recovery/live-object-storage.ts")
        tests=read("tests/recovery-live-object-storage.test.ts")
        for token in ("days<1","days>3650","RecoveryConnectionError"):
            self.assertIn(token,resolver)
        self.assertIn("recovery_live_object_storage_failed",caller)
        self.assertIn("invalid or expired Object Lock configuration is a generic failure",tests)

if __name__=="__main__": unittest.main()
