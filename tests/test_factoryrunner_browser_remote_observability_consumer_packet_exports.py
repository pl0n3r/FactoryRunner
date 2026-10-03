import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")

PUBLIC = {
    "browserRemoteObservabilityConsumerPacket",
    "browserRemoteObservabilityConsumerPacketCompatibility",
}
PRIVATE_RUNTIME = {
    "browserRemoteObservabilityManifest",
    "browserRemoteObservabilityCompatibility",
    "BrowserRemoteDirectory",
    "BrowserRemoteDriver",
    "createBrowserRemoteSupervisor",
    "browserRemoteProfile",
}
EXISTING = {
    "browserRemoteDirectorySnapshot",
    "browserRemoteDirectoryReadiness",
    "browserRemoteDirectoryDoctor",
    "browserRemoteDirectoryHealth",
    "browserRemoteDirectoryMetrics",
    "browserRemoteDirectoryHealthBundle",
    "parseRunnerIdentity",
    "parseExecutionOrder",
    "ExecutionLoop",
    "RuntimeSupervisor",
    "BrowserExecutionAdapter",
    "ControlBotClient",
}


def exports() -> set[str]:
    script = (
        "import * as api from './src/index.ts';"
        "console.log(JSON.stringify(Object.keys(api)))"
    )
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return set(json.loads(raw.strip().splitlines()[-1]))


class FactoryRunnerBrowserRemoteObservabilityConsumerPacketExportsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.public = exports()

    def test_public_index_exports_packet_and_compatibility_validator(self):
        self.assertTrue(PUBLIC.issubset(self.public))
        self.assertTrue(EXISTING.issubset(self.public))

        for symbol in (
            "BrowserRemoteObservabilityConsumerPacket",
            "BrowserRemoteObservabilityConsumerPacketCompatibility",
            "BrowserRemoteObservabilityConsumerPacketCompatibilityReason",
        ):
            self.assertIn(symbol, SOURCE)

        for module in (
            "./browser-remote-observability-consumer-packet.ts",
            "./browser-remote-observability-consumer-packet-compatibility.ts",
        ):
            self.assertIn(f"from '{module}'", SOURCE)

    def test_public_exports_keep_transport_provider_and_execution_surfaces_private(self):
        self.assertTrue(PRIVATE_RUNTIME.isdisjoint(self.public))

        for module in (
            "./browser-remote-directory.ts",
            "./browser-remote-driver.ts",
            "./browser-remote-supervisor.ts",
            "./browser-remote-observability-manifest.ts",
            "./browser-remote-observability-compatibility.ts",
        ):
            self.assertNotIn(f"from '{module}'", SOURCE)


if __name__ == "__main__":
    unittest.main()
