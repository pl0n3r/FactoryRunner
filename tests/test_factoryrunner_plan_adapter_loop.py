"""Aceptación ejecutable del ExecutionLoop ligado al ExecutionPlan FactoryRunner #111."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node() -> dict[str, object]:
    script = r"""
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { AdapterRegistry } from './src/adapters/programmatic.ts';
    import { ExecutionLoop } from './src/execution-loop.ts';
    import { DurableJournal } from './src/journal.ts';
    import { orderFingerprint } from './src/order.ts';
    import { parseRunnerIdentity } from './src/runner.ts';
    import { stableSha256 } from './src/validation.ts';

    const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
    const ORDER_ID = '22222222-2222-7222-8222-222222222222';
    const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-plan-loop-'));

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
          evidence: { code: 'fake-ok', summary: 'Synthetic adapter executed', ref: null },
        };
      }
    }

    const identity = parseRunnerIdentity({
      version: 1,
      runner_id: RUNNER_ID,
      protocol_version: 1,
      runtime: 'node',
      runtime_version: '0.1.4',
      platform: 'linux-arm64',
      location: 'test',
      capabilities: ['git.head', 'git.status'],
      max_parallel: 1,
    });
    const order = {
      version: 1,
      order_id: ORDER_ID,
      work_item_id: 'factoryrunner:work:111',
      runner_id: RUNNER_ID,
      capability: 'git.head',
      attempt: 1,
      issued_at: 1_000,
      expires_at: 2_000,
      instruction_ref: 'controlbot:instruction:factoryrunner-111',
    };

    function plan(overrides = {}) {
      const core = {
        version: 1,
        authority: 'unchanged',
        runner_id: RUNNER_ID,
        order_id: ORDER_ID,
        work_item_id: 'factoryrunner:work:111',
        capability: 'git.head',
        order_fingerprint: orderFingerprint(order),
        admission_fingerprint: 'a'.repeat(64),
        adapter_id: 'git-a',
        manifest_fingerprint: 'b'.repeat(64),
        resource_fingerprint: 'c'.repeat(64),
        ...overrides,
      };
      return { ...core, fingerprint: stableSha256(core) };
    }

    function loop(path, registry) {
      return new ExecutionLoop({
        journal: new DurableJournal(path),
        registry,
        identity,
        now: () => 1_100,
      });
    }

    const git = new FakeAdapter('git-a', ['git.head']);
    const status = new FakeAdapter('status-a', ['git.status']);
    const registry = new AdapterRegistry([git, status]);

    try {
      const exact = await loop(join(directory, 'exact.ndjson'), registry).executePlan(
        order,
        plan(),
        { timeout_ms: 100 },
      );

      let missingRejected = false;
      try {
        await loop(join(directory, 'missing.ndjson'), registry).executePlan(order, undefined);
      } catch {
        missingRejected = true;
      }

      let staleRejected = false;
      try {
        await loop(join(directory, 'stale.ndjson'), registry).executePlan(
          order,
          plan({ order_fingerprint: 'd'.repeat(64) }),
        );
      } catch {
        staleRejected = true;
      }

      const invalidFingerprint = plan();
      invalidFingerprint.fingerprint = 'e'.repeat(64);
      let invalidFingerprintRejected = false;
      try {
        await loop(join(directory, 'fingerprint.ndjson'), registry).executePlan(
          order,
          invalidFingerprint,
        );
      } catch {
        invalidFingerprintRejected = true;
      }

      const mismatch = await loop(join(directory, 'mismatch.ndjson'), registry).executePlan(
        order,
        plan({ adapter_id: 'status-a' }),
        { timeout_ms: 100 },
      );

      console.log(JSON.stringify({
        exactState: exact.event.state,
        exactCapability: exact.adapter_result?.capability ?? null,
        missingRejected,
        staleRejected,
        invalidFingerprintRejected,
        mismatchState: mismatch.event.state,
        mismatchResult: mismatch.adapter_result,
        gitCalls: git.calls,
        statusCalls: status.calls,
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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


class FactoryRunnerPlanAdapterLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = run_node()

    def test_execution_loop_dispatches_exact_adapter_from_execution_plan(self):
        observed = self.observed
        self.assertEqual(observed["exactState"], "completed")
        self.assertEqual(observed["exactCapability"], "git.head")
        self.assertEqual(observed["gitCalls"], ["git.head"])
        self.assertEqual(observed["statusCalls"], [])

    def test_missing_stale_or_mismatched_plan_blocks_before_adapter_effect(self):
        observed = self.observed
        self.assertTrue(observed["missingRejected"])
        self.assertTrue(observed["staleRejected"])
        self.assertTrue(observed["invalidFingerprintRejected"])
        self.assertEqual(observed["mismatchState"], "failed")
        self.assertIsNone(observed["mismatchResult"])
        self.assertEqual(observed["gitCalls"], ["git.head"])
        self.assertEqual(observed["statusCalls"], [])


if __name__ == "__main__":
    unittest.main()
