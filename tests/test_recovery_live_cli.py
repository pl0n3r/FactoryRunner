"""Aceptación ejecutable FactoryRunner #43."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryLiveCliTests(unittest.TestCase):
    def test_live_recovery_is_exported(self):
        index=read("src/index.ts")
        self.assertIn("RecoveryLiveObjectStorage",index)
        self.assertIn("RecoveryLiveObjectStorageError",index)

    def test_cli_contract_uses_opaque_alias_without_inline_credentials(self):
        source=read("scripts/recovery-live-object-storage.ts")
        self.assertIn("RecoveryLiveObjectStorage",source)
        self.assertNotIn("ACCESS_KEY_ID",source)
        self.assertNotIn("SECRET_ACCESS_KEY",source)

    def test_artifact_root_rejects_traversal_and_unsafe_paths(self):
        source=read("scripts/recovery-live-object-storage.ts")
        tests=read("tests/recovery-live-cli.test.ts")
        self.assertIn("relative(root,candidate)",source)
        self.assertIn("isSymbolicLink",source)
        self.assertIn("rejects traversal/symlink",tests)

    def test_cli_output_and_errors_are_sanitized(self):
        source=read("scripts/recovery-live-object-storage.ts")
        self.assertIn("JSON.stringify(result)",source)
        self.assertIn("recovery_live_object_storage_failed",source)
        self.assertNotIn("console.error(error",source)

    def test_cli_does_not_add_destructive_capabilities(self):
        source=read("scripts/recovery-live-object-storage.ts")
        for forbidden in ("recovery.object-storage.delete","retention.delete","restore.production","child_process"):
            self.assertNotIn(forbidden,source)

if __name__=="__main__": unittest.main()
