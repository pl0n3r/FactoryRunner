import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import {
  browserRemoteObservabilityPublicPacket,
} from './src/browser-remote-observability-public-packet.ts';
import {
  browserRemoteObservabilityConsumerPacket,
} from './src/browser-remote-observability-consumer-packet.ts';
import { browserRemoteObservabilityManifest } from './src/browser-remote-observability-manifest.ts';
import { stableSha256 } from './src/validation.ts';

function withFingerprint(core) {
  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}

function bundle(status = 'READY') {
  return withFingerprint({
    version: 1,
    authority: 'unchanged',
    status,
    doctor_fingerprint: 'a'.repeat(64),
    health_fingerprint: 'b'.repeat(64),
    metrics_fingerprint: 'c'.repeat(64),
    snapshot_fingerprint: 'd'.repeat(64),
    readiness_fingerprint: 'e'.repeat(64),
    network_access: false,
    external_mutation: false,
  });
}

function rejected(input) {
  try {
    browserRemoteObservabilityPublicPacket(input);
    return false;
  } catch {
    return true;
  }
}

const healthBundle = bundle();
const first = browserRemoteObservabilityPublicPacket(healthBundle);
const repeated = browserRemoteObservabilityPublicPacket(healthBundle);
const expected = browserRemoteObservabilityConsumerPacket(
  browserRemoteObservabilityManifest(),
  healthBundle,
);
const unavailable = browserRemoteObservabilityPublicPacket(bundle('UNAVAILABLE'));

console.log(JSON.stringify({
  first,
  repeated,
  expected,
  unavailable,
  arity: browserRemoteObservabilityPublicPacket.length,
  frozen: Object.isFrozen(first),
  exportsFrozen: Object.isFrozen(first.exports),
  entriesFrozen: first.exports.every((entry) => Object.isFrozen(entry)),
  hasManifestObject: Object.prototype.hasOwnProperty.call(first, 'manifest'),
  tamperedRejected: rejected({ ...healthBundle, fingerprint: '0'.repeat(64) }),
  extraFieldRejected: rejected({ ...healthBundle, provider: 'example' }),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteObservabilityPublicPacketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_public_factory_builds_canonical_packet_from_health_bundle_only(self):
        item = self.observed["first"]
        self.assertEqual(self.observed["arity"], 1)
        self.assertEqual(item, self.observed["expected"])
        self.assertEqual(item["fingerprint"], self.observed["repeated"]["fingerprint"])
        self.assertEqual(item["status"], "READY")
        self.assertEqual(self.observed["unavailable"]["status"], "UNAVAILABLE")
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["exportsFrozen"])
        self.assertTrue(self.observed["entriesFrozen"])

    def test_public_factory_rejects_tampered_bundle_without_exposing_manifest(self):
        self.assertFalse(self.observed["hasManifestObject"])
        self.assertTrue(self.observed["tamperedRejected"])
        self.assertTrue(self.observed["extraFieldRejected"])


if __name__ == "__main__":
    unittest.main()
