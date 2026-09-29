"""Aceptación ejecutable FactoryRunner #29."""
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text(encoding="utf-8")

class RecoveryObjectStorageAdapterTests(unittest.TestCase):
    def test_factory_descriptor_and_capability_contract(self):
        source=read("src/adapters/recovery-object-storage.ts")
        tests=read("tests/recovery-object-storage-adapter.test.ts")
        self.assertIn("provider!=='object_storage'",source)
        self.assertIn("role!=='primary_offsite'",source)
        self.assertIn("Capability y operation no coinciden",source)
        self.assertIn("Factory descriptor is exact",tests)

    def test_driver_boundary_accepts_only_opaque_refs_and_no_secrets(self):
        source=read("src/adapters/recovery-object-storage.ts")
        tests=read("tests/recovery-object-storage-adapter.test.ts")
        self.assertIn("controlbot:connection/",source)
        self.assertIn("noSensitiveText",source)
        self.assertIn("rejects secrets or URLs",tests)

    def test_result_requires_matching_object_checksum_and_safe_evidence(self):
        source=read("src/adapters/recovery-object-storage.ts")
        self.assertIn("objectRef!==command.object_ref",source)
        self.assertIn("digest!==command.checksum_sha256",source)
        self.assertIn("immutable_version_ref",source)
        self.assertIn("evidence_ref",source)

    def test_descriptor_fingerprint_and_idempotency_contract(self):
        source=read("src/adapters/recovery-object-storage.ts")
        tests=read("tests/recovery-object-storage-adapter.test.ts")
        self.assertIn("stableSha256(base)!==descriptorId",source)
        self.assertIn("idempotency_key",source)
        self.assertIn("idempotency stay deterministic",tests)

    def test_driver_failures_are_generic_and_authority_is_unchanged(self):
        source=read("src/adapters/recovery-object-storage.ts")
        tests=read("tests/recovery-object-storage-adapter.test.ts")
        self.assertIn("recovery_object_storage_failed",source)
        self.assertIn("authority!=='unchanged'",source)
        self.assertIn("driver failures are generic",tests)

    def test_adapter_is_exported_and_node_suite_covers_injected_driver(self):
        index=read("src/index.ts")
        source=read("src/adapters/recovery-object-storage.ts")
        package=json.loads(read("package.json"))
        self.assertIn("RecoveryObjectStorageAdapter",index)
        self.assertIn("RecoveryObjectStorageDriver",source)
        self.assertIn("tests/*.test.ts",package["scripts"]["test"])
        self.assertIn("uses only injected driver",read("tests/recovery-object-storage-adapter.test.ts"))

if __name__=="__main__": unittest.main()
