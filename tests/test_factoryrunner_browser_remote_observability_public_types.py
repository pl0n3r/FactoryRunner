import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKET_SOURCE = (
    ROOT / "src" / "browser-remote-observability-public-packet.ts"
).read_text(encoding="utf-8")
GUARD_SOURCE = (
    ROOT / "src" / "browser-remote-observability-public-consumer-compatibility.ts"
).read_text(encoding="utf-8")
INDEX_SOURCE = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")


def observe() -> dict[str, object]:
    script = r"""
import * as api from './src/index.ts';
import { stableSha256 } from './src/validation.ts';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

const healthBundle = withFingerprint({
  version: 1,
  authority: 'unchanged',
  status: 'READY',
  doctor_fingerprint: 'a'.repeat(64),
  health_fingerprint: 'b'.repeat(64),
  metrics_fingerprint: 'c'.repeat(64),
  snapshot_fingerprint: 'd'.repeat(64),
  readiness_fingerprint: 'e'.repeat(64),
  network_access: false,
  external_mutation: false,
});
const consumer = {
  version: 1,
  manifest_version: 1,
  required_exports: [
    { export_name: 'browserRemoteDirectoryHealth', contract_version: 1 },
    { export_name: 'browserRemoteDirectorySnapshot', contract_version: 1 },
  ],
};

const packet = api.browserRemoteObservabilityPublicPacket(healthBundle);
const compatibility = api.browserRemoteObservabilityPublicConsumerCompatibility(
  packet,
  consumer,
);

console.log(JSON.stringify({
  exports: Object.keys(api),
  packet,
  compatibility,
  packetArity: api.browserRemoteObservabilityPublicPacket.length,
  compatibilityArity: api.browserRemoteObservabilityPublicConsumerCompatibility.length,
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityPublicTypesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.public = set(cls.observed["exports"])

    def test_public_factories_use_typed_inputs_without_runtime_change(self):
        self.assertIn(
            "healthBundleInput: BrowserRemoteDirectoryHealthBundle",
            PACKET_SOURCE,
        )
        self.assertIn(
            "packetInput: BrowserRemoteObservabilityConsumerPacket",
            GUARD_SOURCE,
        )
        self.assertIn(
            "consumerInput: BrowserRemoteObservabilityPublicConsumer",
            GUARD_SOURCE,
        )
        self.assertNotIn("healthBundleInput: unknown", PACKET_SOURCE)
        self.assertNotIn("packetInput: unknown", GUARD_SOURCE)
        self.assertNotIn("consumerInput: unknown", GUARD_SOURCE)

        self.assertEqual(self.observed["packetArity"], 1)
        self.assertEqual(self.observed["compatibilityArity"], 2)
        self.assertEqual(self.observed["packet"]["status"], "READY")
        self.assertEqual(self.observed["compatibility"]["status"], "COMPATIBLE")
        self.assertEqual(self.observed["compatibility"]["reasons"], [])
        self.assertFalse(self.observed["packet"]["network_access"])
        self.assertFalse(self.observed["compatibility"]["external_mutation"])

    def test_index_exports_consumer_contract_types_without_internal_runtime_exports(self):
        for symbol in (
            "BrowserRemoteObservabilityPublicConsumer",
            "BrowserRemoteObservabilityPublicRequirement",
        ):
            self.assertIn(f"type {symbol}", GUARD_SOURCE)
            self.assertIn(f"type {symbol}", INDEX_SOURCE)
            self.assertNotIn(symbol, self.public)

        for runtime_symbol in (
            "browserRemoteObservabilityManifest",
            "browserRemoteObservabilityCompatibility",
        ):
            self.assertNotIn(runtime_symbol, self.public)

        for module in (
            "./browser-remote-observability-manifest.ts",
            "./browser-remote-observability-compatibility.ts",
            "./validation.ts",
        ):
            self.assertNotIn(f"from '{module}'", INDEX_SOURCE)


if __name__ == "__main__":
    unittest.main()
