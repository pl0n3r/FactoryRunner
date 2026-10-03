"""Aceptación de exports públicos de observabilidad browser remota (#270)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "src" / "index.ts"

PUBLIC_RUNTIME_EXPORTS = {
    "browserRemoteDirectorySnapshot",
    "browserRemoteDirectoryReadiness",
    "browserRemoteDirectoryDoctor",
    "browserRemoteDirectoryHealth",
    "browserRemoteDirectoryMetrics",
    "browserRemoteDirectoryHealthBundle",
}

PRIVATE_REMOTE_EXECUTORS = {
    "BrowserRemoteDirectory",
    "BrowserRemoteDriver",
    "createBrowserRemoteSupervisor",
    "browserRemoteProfile",
}

EXISTING_PUBLIC_EXPORTS = {
    "parseRunnerIdentity",
    "parseExecutionOrder",
    "ExecutionLoop",
    "RuntimeSupervisor",
    "resourceSnapshot",
    "BrowserExecutionAdapter",
    "ControlBotClient",
}

PUBLIC_TYPE_EXPORTS = {
    "BrowserRemoteDirectorySnapshot",
    "BrowserRemoteDirectoryReadiness",
    "BrowserRemoteDirectoryDoctor",
    "BrowserRemoteDirectoryHealth",
    "BrowserRemoteDirectoryMetrics",
    "BrowserRemoteDirectoryHealthBundle",
    "BrowserRemoteCapability",
    "BrowserRemoteProfile",
}


def runtime_exports() -> set[str]:
    script = r"""
import * as publicApi from './src/index.ts';
console.log(JSON.stringify(Object.keys(publicApi).sort()));
"""
    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return set(json.loads(completed.stdout.strip().splitlines()[-1]))


class FactoryRunnerBrowserRemoteObservabilityExportsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.exports = runtime_exports()
        cls.index_source = INDEX.read_text(encoding="utf-8")

    def test_public_index_exports_only_sanitized_observability_contracts(self):
        self.assertTrue(PUBLIC_RUNTIME_EXPORTS.issubset(self.exports))
        self.assertTrue(PRIVATE_REMOTE_EXECUTORS.isdisjoint(self.exports))

        source = self.index_source
        for type_name in PUBLIC_TYPE_EXPORTS:
            with self.subTest(type_name=type_name):
                self.assertIn(type_name, source)

        for forbidden_module in (
            "./browser-remote-directory.ts",
            "./browser-remote-driver.ts",
            "./browser-remote-supervisor.ts",
        ):
            with self.subTest(forbidden_module=forbidden_module):
                self.assertNotIn(
                    f"from '{forbidden_module}'",
                    source,
                )

    def test_existing_public_exports_remain_intact_and_executors_stay_private(self):
        self.assertTrue(EXISTING_PUBLIC_EXPORTS.issubset(self.exports))
        self.assertTrue(PRIVATE_REMOTE_EXECUTORS.isdisjoint(self.exports))

        expected_modules = (
            "./browser-remote-directory-snapshot.ts",
            "./browser-remote-directory-readiness.ts",
            "./browser-remote-directory-doctor.ts",
            "./browser-remote-directory-health.ts",
            "./browser-remote-directory-metrics.ts",
            "./browser-remote-directory-health-bundle.ts",
        )
        for module in expected_modules:
            with self.subTest(module=module):
                self.assertIn(f"from '{module}'", self.index_source)


if __name__ == "__main__":
    unittest.main()
