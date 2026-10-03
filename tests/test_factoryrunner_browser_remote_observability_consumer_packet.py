import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_EXPORTS = [
    "browserRemoteDirectoryDoctor",
    "browserRemoteDirectoryHealth",
    "browserRemoteDirectoryHealthBundle",
    "browserRemoteDirectoryMetrics",
    "browserRemoteDirectoryReadiness",
    "browserRemoteDirectorySnapshot",
]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteObservabilityConsumerPacket } from './src/browser-remote-observability-consumer-packet.ts';
import { browserRemoteObservabilityManifest } from './src/browser-remote-observability-manifest.ts';
import { stableSha256 } from './src/validation.ts';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

function bundle(status, seed) {
  return withFingerprint({
    version: 1,
    authority: 'unchanged',
    status,
    doctor_fingerprint: seed.repeat(64),
    health_fingerprint: (seed === 'a' ? 'b' : 'c').repeat(64),
    metrics_fingerprint: (seed === 'a' ? 'd' : 'e').repeat(64),
    snapshot_fingerprint: (seed === 'a' ? 'f' : '1').repeat(64),
    readiness_fingerprint: (seed === 'a' ? '2' : '3').repeat(64),
    network_access: false,
    external_mutation: false,
  });
}

function rejected(manifest, healthBundle) {
  try {
    browserRemoteObservabilityConsumerPacket(manifest, healthBundle);
    return false;
  } catch {
    return true;
  }
}

const manifest = browserRemoteObservabilityManifest();
const readyBundle = bundle('READY', 'a');
const unavailableBundle = bundle('UNAVAILABLE', '4');
const first = browserRemoteObservabilityConsumerPacket(manifest, readyBundle);
const repeated = browserRemoteObservabilityConsumerPacket(manifest, readyBundle);
const unavailable = browserRemoteObservabilityConsumerPacket(
  manifest,
  unavailableBundle,
);
const serialized = JSON.stringify(first);

console.log(JSON.stringify({
  first,
  repeated,
  unavailable,
  frozen: Object.isFrozen(first),
  exportsFrozen: Object.isFrozen(first.exports),
  entriesFrozen: first.exports.every((entry) => Object.isFrozen(entry)),
  tamperedManifestRejected: rejected(
    { ...manifest, fingerprint: '0'.repeat(64) },
    readyBundle,
  ),
  extraManifestRejected: rejected(
    { ...manifest, path: '/tmp/private.ts' },
    readyBundle,
  ),
  tamperedBundleRejected: rejected(
    manifest,
    { ...readyBundle, status: 'UNAVAILABLE' },
  ),
  extraBundleRejected: rejected(
    manifest,
    { ...readyBundle, provider: 'example' },
  ),
  containsPath: serialized.includes('./') || serialized.includes('.ts'),
  containsProvider: serialized.toLowerCase().includes('provider'),
  containsEndpoint: serialized.includes('http://') || serialized.includes('https://'),
  containsTransport: serialized.toLowerCase().includes('transport'),
  containsSecret: serialized.toLowerCase().includes('secret'),
  containsAlias: serialized.toLowerCase().includes('alias'),
  containsLocation: serialized.toLowerCase().includes('hostinger'),
}));
"""
    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityConsumerPacketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_packet_binds_manifest_and_health_bundle_with_stable_fingerprint(self):
        item = self.observed["first"]
        repeated = self.observed["repeated"]
        unavailable = self.observed["unavailable"]

        self.assertEqual(item["version"], 1)
        self.assertEqual(item["authority"], "unchanged")
        self.assertEqual(item["status"], "READY")
        self.assertEqual(
            [entry["export_name"] for entry in item["exports"]],
            EXPECTED_EXPORTS,
        )
        self.assertTrue(
            all(entry["contract_version"] == 1 for entry in item["exports"])
        )
        self.assertRegex(item["manifest_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(item["health_bundle_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(item["snapshot_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(item["readiness_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(item["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(item["fingerprint"], repeated["fingerprint"])
        self.assertEqual(unavailable["status"], "UNAVAILABLE")
        self.assertFalse(item["network_access"])
        self.assertFalse(item["external_mutation"])

        for key in (
            "tamperedManifestRejected",
            "extraManifestRejected",
            "tamperedBundleRejected",
            "extraBundleRejected",
        ):
            with self.subTest(case=key):
                self.assertTrue(self.observed[key])

    def test_packet_is_sanitized_immutable_and_external_io_free(self):
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["exportsFrozen"])
        self.assertTrue(self.observed["entriesFrozen"])
        for key in (
            "containsPath",
            "containsProvider",
            "containsEndpoint",
            "containsTransport",
            "containsSecret",
            "containsAlias",
            "containsLocation",
        ):
            with self.subTest(key=key):
                self.assertFalse(self.observed[key])


if __name__ == "__main__":
    unittest.main()
