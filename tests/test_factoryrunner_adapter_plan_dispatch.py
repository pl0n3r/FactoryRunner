"""Aceptación ejecutable del despacho exacto adapter_id + capability FactoryRunner #110."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node() -> dict[str, object]:
    script = r"""
    import { AdapterRegistry } from './src/adapters/programmatic.ts';

    class FakeAdapter {
      constructor(id, capabilities) {
        this.id = id;
        this.capabilities = capabilities;
        this.calls = [];
      }

      async execute(capability) {
        this.calls.push(capability);
        return {
          capability,
          data: { ok: true },
          evidence: {
            code: 'fake-ok',
            summary: 'Synthetic adapter executed',
            ref: null,
          },
        };
      }
    }

    const git = new FakeAdapter('git-a', ['git.head']);
    const status = new FakeAdapter('status-a', ['git.status']);
    const registry = new AdapterRegistry([git, status]);

    const exact = await registry.executeAdapter('git-a', 'git.head');

    let unknownRejected = false;
    try {
      await registry.executeAdapter('missing-adapter', 'git.head');
    } catch {
      unknownRejected = true;
    }

    let mismatchRejected = false;
    try {
      await registry.executeAdapter('git-a', 'git.status');
    } catch {
      mismatchRejected = true;
    }

    let duplicateRejected = false;
    try {
      new AdapterRegistry([
        new FakeAdapter('duplicate', ['git.branch']),
        new FakeAdapter('duplicate', ['git.tag']),
      ]);
    } catch {
      duplicateRejected = true;
    }

    console.log(JSON.stringify({
      exact,
      gitCalls: git.calls,
      statusCalls: status.calls,
      unknownRejected,
      mismatchRejected,
      duplicateRejected,
    }));
    """
    result = subprocess.run(
        (
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
        ),
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise AssertionError(output)
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError("Node test did not emit JSON output.\n" + output)
    return json.loads(lines[-1])


class FactoryRunnerAdapterPlanDispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = run_node()

    def test_registry_executes_exact_plan_adapter_id_and_capability(self):
        observed = self.observed
        self.assertEqual(observed["exact"]["capability"], "git.head")
        self.assertEqual(observed["gitCalls"], ["git.head"])
        self.assertEqual(observed["statusCalls"], [])

    def test_adapter_id_capability_mismatch_fails_closed_without_effect(self):
        observed = self.observed
        self.assertTrue(observed["unknownRejected"])
        self.assertTrue(observed["mismatchRejected"])
        self.assertTrue(observed["duplicateRejected"])
        self.assertEqual(observed["gitCalls"], ["git.head"])
        self.assertEqual(observed["statusCalls"], [])


if __name__ == "__main__":
    unittest.main()
