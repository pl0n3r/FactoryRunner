import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import {
  browserRemoteObservabilityPublicConsumerCompatibility,
} from './src/browser-remote-observability-public-consumer-compatibility.ts';
import {
  browserRemoteObservabilityConsumerPacketCompatibility,
} from './src/browser-remote-observability-consumer-packet-compatibility.ts';
import {
  browserRemoteObservabilityCompatibility,
} from './src/browser-remote-observability-compatibility.ts';
import {
  browserRemoteObservabilityPublicPacket,
} from './src/browser-remote-observability-public-packet.ts';
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

const manifest = browserRemoteObservabilityManifest();
const packet = browserRemoteObservabilityPublicPacket(bundle());
const supportedConsumer = {
  version: 1,
  manifest_version: 1,
  required_exports: [
    { export_name: 'browserRemoteDirectoryHealth', contract_version: 1 },
    { export_name: 'browserRemoteDirectorySnapshot', contract_version: 1 },
  ],
};
const compatibility = browserRemoteObservabilityCompatibility(
  manifest,
  supportedConsumer,
);
const expected = browserRemoteObservabilityConsumerPacketCompatibility(
  packet,
  manifest,
  supportedConsumer,
  compatibility,
);
const first = browserRemoteObservabilityPublicConsumerCompatibility(
  packet,
  supportedConsumer,
);
const repeated = browserRemoteObservabilityPublicConsumerCompatibility(
  packet,
  supportedConsumer,
);

const incompatibleConsumer = {
  ...supportedConsumer,
  required_exports: [
    { export_name: 'browserRemoteDirectoryUnknown', contract_version: 1 },
  ],
};
const incompatibleCompatibility = browserRemoteObservabilityCompatibility(
  manifest,
  incompatibleConsumer,
);
const incompatibleExpected = browserRemoteObservabilityConsumerPacketCompatibility(
  packet,
  manifest,
  incompatibleConsumer,
  incompatibleCompatibility,
);
const incompatible = browserRemoteObservabilityPublicConsumerCompatibility(
  packet,
  incompatibleConsumer,
);

const cases = {
  tamperedPacket: browserRemoteObservabilityPublicConsumerCompatibility(
    { ...packet, fingerprint: '0'.repeat(64) },
    supportedConsumer,
  ),
  extraPacketField: browserRemoteObservabilityPublicConsumerCompatibility(
    { ...packet, provider: 'example' },
    supportedConsumer,
  ),
  invalidConsumer: browserRemoteObservabilityPublicConsumerCompatibility(
    packet,
    { ...supportedConsumer, provider: 'example' },
  ),
};

console.log(JSON.stringify({
  first,
  repeated,
  expected,
  incompatible,
  incompatibleExpected,
  cases,
  arity: browserRemoteObservabilityPublicConsumerCompatibility.length,
  frozen: Object.isFrozen(first),
  reasonsFrozen: Object.isFrozen(first.reasons),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityPublicConsumerGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_public_guard_validates_consumer_without_manifest_or_compatibility_input(self):
        item = self.observed["first"]

        self.assertEqual(self.observed["arity"], 2)
        self.assertEqual(item, self.observed["expected"])
        self.assertEqual(item["status"], "COMPATIBLE")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(
            item["fingerprint"],
            self.observed["repeated"]["fingerprint"],
        )
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["reasonsFrozen"])
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])

    def test_public_guard_fails_closed_on_incompatible_or_tampered_packet(self):
        incompatible = self.observed["incompatible"]

        self.assertEqual(incompatible, self.observed["incompatibleExpected"])
        self.assertEqual(incompatible["status"], "INCOMPATIBLE")
        self.assertIn("CONSUMER_INCOMPATIBLE", incompatible["reasons"])

        expected = {
            "tamperedPacket": "PACKET_INVALID",
            "extraPacketField": "PACKET_INVALID",
            "invalidConsumer": "CONSUMER_INCOMPATIBLE",
        }
        for name, reason in expected.items():
            with self.subTest(case=name):
                item = self.observed["cases"][name]
                self.assertEqual(item["status"], "INCOMPATIBLE")
                self.assertIn(reason, item["reasons"])
                self.assertFalse(item["network_access"])
                self.assertFalse(item["external_mutation"])


if __name__ == "__main__":
    unittest.main()
