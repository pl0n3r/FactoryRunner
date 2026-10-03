import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")
OBSERVABILITY = (
    "browserRemoteDirectorySnapshot",
    "browserRemoteDirectoryReadiness",
    "browserRemoteDirectoryDoctor",
    "browserRemoteDirectoryHealth",
    "browserRemoteDirectoryMetrics",
    "browserRemoteDirectoryHealthBundle",
)
MODULES = tuple(
    "./browser-remote-" + suffix + ".ts"
    for suffix in (
        "directory-snapshot",
        "directory-readiness",
        "directory-doctor",
        "directory-health",
        "directory-metrics",
        "directory-health-bundle",
    )
)
PRIVATE = {
    "BrowserRemoteDirectory",
    "BrowserRemoteDriver",
    "createBrowserRemoteSupervisor",
    "browserRemoteProfile",
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


class FactoryRunnerBrowserRemoteObservabilityExportsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.public = exports()

    def test_public_index_exports_only_sanitized_observability_contracts(self):
        self.assertTrue(set(OBSERVABILITY).issubset(self.public))
        self.assertTrue(PRIVATE.isdisjoint(self.public))
        for name in OBSERVABILITY:
            self.assertIn(name[0].upper() + name[1:], SOURCE)
        for name in ("BrowserRemoteCapability", "BrowserRemoteProfile"):
            self.assertIn(name, SOURCE)
        for module in (
            "./browser-remote-directory.ts",
            "./browser-remote-driver.ts",
            "./browser-remote-supervisor.ts",
        ):
            self.assertNotIn(f"from '{module}'", SOURCE)

    def test_existing_public_exports_remain_intact_and_executors_stay_private(self):
        existing = {
            "parseRunnerIdentity",
            "parseExecutionOrder",
            "ExecutionLoop",
            "RuntimeSupervisor",
            "resourceSnapshot",
            "BrowserExecutionAdapter",
            "ControlBotClient",
        }
        self.assertTrue(existing.issubset(self.public))
        self.assertTrue(PRIVATE.isdisjoint(self.public))
        for module in MODULES:
            self.assertIn(f"from '{module}'", SOURCE)


if __name__ == "__main__":
    unittest.main()
