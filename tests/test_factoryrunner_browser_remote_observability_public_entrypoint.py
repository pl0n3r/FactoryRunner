import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")

PUBLIC = {
    "browserRemoteObservabilityPublicPacket",
    "browserRemoteObservabilityPublicConsumerCompatibility",
}
PRIVATE = {
    "browserRemoteObservabilityManifest",
    "browserRemoteObservabilityCompatibility",
    "BrowserRemoteDirectory",
    "BrowserRemoteDriver",
    "createBrowserRemoteSupervisor",
    "browserRemoteProfile",
}
EXISTING = {
    "browserRemoteObservabilityConsumerPacket",
    "browserRemoteObservabilityConsumerPacketCompatibility",
    "browserRemoteDirectoryHealthBundle",
    "browserRemoteDirectorySnapshot",
    "parseRunnerIdentity",
    "ExecutionLoop",
    "RuntimeSupervisor",
    "BrowserExecutionAdapter",
    "ControlBotClient",
}


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


class FactoryRunnerBrowserRemoteObservabilityPublicEntrypointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.public = set(cls.observed["exports"])

    def test_index_exposes_self_contained_packet_factory_and_consumer_guard(self):
        self.assertTrue(PUBLIC.issubset(self.public))
        self.assertTrue(EXISTING.issubset(self.public))
        self.assertEqual(self.observed["packetArity"], 1)
        self.assertEqual(self.observed["compatibilityArity"], 2)
        self.assertEqual(self.observed["packet"]["status"], "READY")
        self.assertEqual(self.observed["compatibility"]["status"], "COMPATIBLE")
        self.assertEqual(self.observed["compatibility"]["reasons"], [])

        for symbol in (
            "BrowserRemoteObservabilityPublicPacket",
            "BrowserRemoteObservabilityPublicConsumerCompatibility",
        ):
            self.assertIn(symbol, SOURCE)

        for module in (
            "./browser-remote-observability-public-packet.ts",
            "./browser-remote-observability-public-consumer-compatibility.ts",
        ):
            self.assertIn(f"from '{module}'", SOURCE)

    def test_internal_manifest_compatibility_and_execution_surfaces_remain_private(self):
        self.assertTrue(PRIVATE.isdisjoint(self.public))

        for module in (
            "./browser-remote-observability-manifest.ts",
            "./browser-remote-observability-compatibility.ts",
            "./browser-remote-directory.ts",
            "./browser-remote-driver.ts",
            "./browser-remote-supervisor.ts",
            "./validation.ts",
        ):
            self.assertNotIn(f"from '{module}'", SOURCE)


if __name__ == "__main__":
    unittest.main()
