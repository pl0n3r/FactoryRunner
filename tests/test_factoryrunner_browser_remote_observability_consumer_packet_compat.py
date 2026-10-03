import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import {
  browserRemoteObservabilityConsumerPacketCompatibility,
} from './src/browser-remote-observability-consumer-packet-compatibility.ts';
import {
  browserRemoteObservabilityCompatibility,
} from './src/browser-remote-observability-compatibility.ts';
import {
  browserRemoteObservabilityConsumerPacket,
} from './src/browser-remote-observability-consumer-packet.ts';
import { browserRemoteObservabilityManifest } from './src/browser-remote-observability-manifest.ts';
import { stableSha256 } from './src/validation.ts';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

function bundle() {
  return withFingerprint({
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
}

function refingerprintPacket(packet, overrides) {
  const core = {
    version: packet.version,
    authority: packet.authority,
    status: packet.status,
    exports: packet.exports,
    manifest_fingerprint: packet.manifest_fingerprint,
    health_bundle_fingerprint: packet.health_bundle_fingerprint,
    snapshot_fingerprint: packet.snapshot_fingerprint,
    readiness_fingerprint: packet.readiness_fingerprint,
    network_access: packet.network_access,
    external_mutation: packet.external_mutation,
    ...overrides,
  };
  return withFingerprint(core);
}

const manifest = browserRemoteObservabilityManifest();
const packet = browserRemoteObservabilityConsumerPacket(manifest, bundle());
const supportedConsumer = {
  version: 1,
  manifest_version: 1,
  required_exports: [
    { export_name: 'browserRemoteDirectoryHealth', contract_version: 1 },
    { export_name: 'browserRemoteDirectorySnapshot', contract_version: 1 },
  ],
};
const supportedCompatibility = browserRemoteObservabilityCompatibility(
  manifest,
  supportedConsumer,
);
const compatible = browserRemoteObservabilityConsumerPacketCompatibility(
  packet,
  manifest,
  supportedConsumer,
  supportedCompatibility,
);
const repeated = browserRemoteObservabilityConsumerPacketCompatibility(
  packet,
  manifest,
  supportedConsumer,
  supportedCompatibility,
);

const unsupportedConsumer = {
  ...supportedConsumer,
  required_exports: [
    { export_name: 'browserRemoteDirectoryUnknown', contract_version: 1 },
  ],
};
const unsupportedCompatibility = browserRemoteObservabilityCompatibility(
  manifest,
  unsupportedConsumer,
);
const mixedPacket = refingerprintPacket(packet, {
  manifest_fingerprint: '0'.repeat(64),
});

const cases = {
  tamperedPacket: browserRemoteObservabilityConsumerPacketCompatibility(
    { ...packet, fingerprint: '0'.repeat(64) },
    manifest,
    supportedConsumer,
    supportedCompatibility,
  ),
  mixedPacket: browserRemoteObservabilityConsumerPacketCompatibility(
    mixedPacket,
    manifest,
    supportedConsumer,
    supportedCompatibility,
  ),
  tamperedManifest: browserRemoteObservabilityConsumerPacketCompatibility(
    packet,
    { ...manifest, fingerprint: '0'.repeat(64) },
    supportedConsumer,
    supportedCompatibility,
  ),
  incompatibleConsumer: browserRemoteObservabilityConsumerPacketCompatibility(
    packet,
    manifest,
    unsupportedConsumer,
    unsupportedCompatibility,
  ),
  tamperedCompatibility: browserRemoteObservabilityConsumerPacketCompatibility(
    packet,
    manifest,
    supportedConsumer,
    { ...supportedCompatibility, status: 'INCOMPATIBLE' },
  ),
  extraCompatibilityField: browserRemoteObservabilityConsumerPacketCompatibility(
    packet,
    manifest,
    supportedConsumer,
    { ...supportedCompatibility, provider: 'example' },
  ),
};

console.log(JSON.stringify({
  manifest,
  packet,
  supportedCompatibility,
  compatible,
  repeated,
  cases,
  frozen: Object.isFrozen(compatible),
  reasonsFrozen: Object.isFrozen(compatible.reasons),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityConsumerPacketCompatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_compatible_consumer_accepts_matching_canonical_packet(self):
        item = self.observed["compatible"]
        packet = self.observed["packet"]
        manifest = self.observed["manifest"]
        compatibility = self.observed["supportedCompatibility"]

        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "COMPATIBLE")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(item["packet_fingerprint"], packet["fingerprint"])
        self.assertEqual(item["manifest_fingerprint"], manifest["fingerprint"])
        self.assertEqual(
            item["compatibility_fingerprint"],
            compatibility["fingerprint"],
        )
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])
        self.assertRegex(item["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeated"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["reasonsFrozen"])

    def test_incompatible_tampered_or_mixed_packet_fails_closed(self):
        expected = {
            "tamperedPacket": "PACKET_INVALID",
            "mixedPacket": "PROVENANCE_MISMATCH",
            "tamperedManifest": "MANIFEST_INVALID",
            "incompatibleConsumer": "CONSUMER_INCOMPATIBLE",
            "tamperedCompatibility": "COMPATIBILITY_INVALID",
            "extraCompatibilityField": "COMPATIBILITY_INVALID",
        }

        for name, reason in expected.items():
            with self.subTest(case=name):
                item = self.observed["cases"][name]
                self.assertEqual(item["status"], "INCOMPATIBLE")
                self.assertIn(reason, item["reasons"])
                self.assertFalse(item["network_access"])
                self.assertFalse(item["external_mutation"])
                self.assertRegex(item["fingerprint"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
