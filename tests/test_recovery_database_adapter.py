"""Aceptación ejecutable FactoryRunner #33."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryDatabaseAdapterTests(unittest.TestCase):
    def test_snapshot_descriptor_and_capability_contract(self):
        source=read("src/adapters/recovery-database.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("source!=='database'",source)
        self.assertIn("operation!=='snapshot'",source)
        self.assertIn("snapshot descriptor and capability contract",tests)

    def test_restore_is_disposable_only_and_fails_closed_for_production_targets(self):
        source=read("src/adapters/recovery-database.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("target.kind!=='disposable'",source)
        self.assertIn("'production','live','cutover'",tests)

    def test_driver_boundary_rejects_dsn_credentials_sql_urls_and_extra_fields(self):
        source=read("src/adapters/recovery-database.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("controlbot:connection/",source)
        self.assertIn("DROP TABLE users",tests)
        self.assertIn("mysql://db.example/app",tests)

    def test_results_must_match_descriptor_and_driver_failures_are_generic(self):
        source=read("src/adapters/recovery-database.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("recovery_database_failed",source)
        self.assertIn("results must match descriptor",tests)

    def test_fingerprint_idempotency_and_authority_contract(self):
        source=read("src/adapters/recovery-database.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("stableSha256(canonical)",source)
        self.assertIn("authority!=='unchanged'",source)
        self.assertIn("fingerprint idempotency",tests)

    def test_adapter_is_exported_and_node_suite_uses_only_injected_driver(self):
        source=read("src/index.ts")
        tests=read("tests/recovery-database-adapter.test.ts")
        self.assertIn("RecoveryDatabaseAdapter",source)
        self.assertIn("no real database or process implementation",tests)

if __name__=="__main__":
    unittest.main()
