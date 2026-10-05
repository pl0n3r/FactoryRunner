import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_SOURCE = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")

PUBLIC_FUNCTIONS = {
    "executionRecoveryHandoffPacket",
    "executionRecoveryHandoffVerify",
    "executionRecoveryHandoffPreview",
    "executionRecoveryHandoffManifest",
    "executionRecoveryHandoffManifestVerify",
    "executionRecoveryHandoffManifestPreview",
}
PUBLIC_TYPES = {
    "ExecutionRecoveryHandoffPacket",
    "ExecutionRecoveryHandoffVerification",
    "ExecutionRecoveryHandoffPreview",
    "ExecutionRecoveryHandoffManifest",
    "ExecutionRecoveryHandoffManifestVerification",
    "ExecutionRecoveryHandoffManifestPreview",
}
MODULES = (
    "execution-recovery-handoff-packet",
    "execution-recovery-handoff-verify",
    "execution-recovery-handoff-preview",
    "execution-recovery-handoff-manifest",
    "execution-recovery-handoff-manifest-verify",
    "execution-recovery-handoff-manifest-preview",
)


def observe() -> dict[str, object]:
    script = r"""
import * as api from './src/index.ts';
import { stableSha256 } from './src/validation.ts';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

const snapshotFingerprint = 'a'.repeat(64);
const planFingerprint = 'b'.repeat(64);
const readiness = withFingerprint({
  version: 1,
  authority: 'unchanged',
  ready: true,
  reason: 'ready',
  snapshot_fingerprint: snapshotFingerprint,
  plan_fingerprint: planFingerprint,
  execution: false,
  network_access: false,
  external_mutation: false,
  counts: {
    orders: 1,
    noop: 1,
    redeliver: 0,
    resume: 0,
    block: 0,
  },
});
const executionId = 'execution-public-api-383';
const packet = api.executionRecoveryHandoffPacket(
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);
const verification = api.executionRecoveryHandoffVerify(
  packet,
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);
const preview = api.executionRecoveryHandoffPreview(
  packet,
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);
const manifest = api.executionRecoveryHandoffManifest(
  packet,
  verification,
  preview,
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);
const manifestVerification = api.executionRecoveryHandoffManifestVerify(
  manifest,
  packet,
  verification,
  preview,
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);
const manifestPreview = api.executionRecoveryHandoffManifestPreview(
  manifest,
  packet,
  verification,
  preview,
  executionId,
  readiness,
  snapshotFingerprint,
  planFingerprint,
);

console.log(JSON.stringify({
  exports: Object.keys(api),
  values: [
    packet,
    verification,
    preview,
    manifest,
    manifestVerification,
    manifestPreview,
  ],
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerExecutionRecoveryHandoffPublicApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.public = set(cls.observed["exports"])

    def test_public_entrypoint_exports_supported_recovery_handoff_contracts(self):
        self.assertTrue(PUBLIC_FUNCTIONS.issubset(self.public))
        for symbol in PUBLIC_TYPES:
            self.assertIn(f"type {symbol}", INDEX_SOURCE)
        for module in MODULES:
            self.assertIn(f"from './{module}.ts'", INDEX_SOURCE)

    def test_public_recovery_handoff_surface_adds_no_execution_or_io_authority(self):
        for value in self.observed["values"]:
            self.assertEqual(value["authority"], "unchanged")
            self.assertFalse(value["execution"])
            self.assertFalse(value["network_access"])
            self.assertFalse(value["external_mutation"])

        self.assertNotIn("stableSha256", self.public)
        for module in MODULES:
            source = (ROOT / "src" / f"{module}.ts").read_text(encoding="utf-8")
            for forbidden in (
                "node:fs",
                "node:net",
                "node:http",
                "node:https",
                "node:child_process",
            ):
                self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
