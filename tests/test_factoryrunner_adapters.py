"""Aceptación ejecutable del slice FactoryRunner #13."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class FactoryRunnerAdaptersTests(unittest.TestCase):
    def test_registry_contract(self):
        source = read("src/adapters/programmatic.ts")
        tests = read("tests/programmatic-adapters.test.ts")
        self.assertIn("class AdapterRegistry", source)
        self.assertIn("Capability registrada por más de un adapter", source)
        self.assertIn("Capability sin adapter programático", source)
        self.assertIn("dispatches exact capability", tests)

    def test_execfile_security_contract(self):
        source = read("src/adapters/programmatic.ts")
        self.assertIn("execFile", source)
        self.assertIn("shell: false", source)
        self.assertIn("Ejecutable no permitido", source)
        self.assertIn("cwd debe ser absoluto", source)
        self.assertIn("GIT_TERMINAL_PROMPT: '0'", source)
        self.assertNotIn("...process.env", source)

    def test_git_head_contract(self):
        source = read("src/adapters/git-read.ts")
        tests = read("tests/programmatic-adapters.test.ts")
        self.assertIn("['rev-parse', '--verify', 'HEAD']", source)
        self.assertIn("GIT_SHA_RE", source)
        self.assertIn("git_head_invalid", source)
        self.assertIn("validates stdout", tests)

    def test_git_status_contract(self):
        source = read("src/adapters/git-read.ts")
        tests = read("tests/programmatic-adapters.test.ts")
        self.assertIn("['status', '--porcelain=v1', '--untracked-files=no']", source)
        self.assertIn("changed_tracked_files", source)
        self.assertIn("never filenames", tests)
        self.assertIn("token=supersecret", tests)

    def test_process_failure_contract(self):
        source = read("src/adapters/git-read.ts")
        tests = read("tests/programmatic-adapters.test.ts")
        self.assertIn("git_read_failed", source)
        self.assertIn("ProgrammaticProcessError", source)
        self.assertIn("stderr token=supersecretvalue", tests)

    def test_real_git_integration_contract(self):
        package = json.loads(read("package.json"))
        version = json.loads(read("config/version.json"))
        tests = read("tests/programmatic-adapters.test.ts")
        self.assertEqual(version["version"], "0.1.2")
        self.assertIn("GitReadAdapter.create(process.cwd())", tests)
        self.assertIn("against the CI checkout without network", tests)
        self.assertIn("node --experimental-strip-types --test", package["scripts"]["test"])
        self.assertIn("node --experimental-strip-types scripts/build.ts", package["scripts"]["build"])


if __name__ == "__main__":
    unittest.main()
