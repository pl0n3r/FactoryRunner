"""Regresión de ExecutionLoop ligado al ExecutionPlan (#111)."""
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = r"""
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from './src/adapters/programmatic.ts';
import { ExecutionLoop } from './src/execution-loop.ts';
import { DurableJournal } from './src/journal.ts';
import { orderFingerprint } from './src/order.ts';
import { parseRunnerIdentity } from './src/runner.ts';
import { stableSha256 } from './src/validation.ts';

const runner = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';
const root = mkdtempSync(join(tmpdir(), 'fr-plan-loop-'));
const calls = [];
const adapter = (id, capability) => ({
  id,
  capabilities: [capability],
  async execute(selected) {
    calls.push(id + ':' + selected);
    return {
      capability: selected,
      data: { ok: true },
      evidence: { code: id + '-ok', summary: 'synthetic', ref: null },
    };
  },
});
const registry = new AdapterRegistry([
  adapter('git-a', 'git.head'),
  adapter('status-a', 'git.status'),
]);
const identity = parseRunnerIdentity({
  version: 1, runner_id: runner, protocol_version: 1, runtime: 'node',
  runtime_version: '0.1.4', platform: 'linux-arm64', location: 'test',
  capabilities: ['git.head', 'git.status'], max_parallel: 1,
});
const order = {
  version: 1, order_id: orderId, work_item_id: 'factoryrunner:work:111',
  runner_id: runner, capability: 'git.head', attempt: 1,
  issued_at: 1000, expires_at: 2000,
  instruction_ref: 'controlbot:instruction:factoryrunner-111',
};
const makePlan = (extra = {}) => {
  const core = {
    version: 1, authority: 'unchanged', runner_id: runner, order_id: orderId,
    work_item_id: 'factoryrunner:work:111', capability: 'git.head',
    order_fingerprint: orderFingerprint(order), admission_fingerprint: 'a'.repeat(64),
    adapter_id: 'git-a', manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64), ...extra,
  };
  return { ...core, fingerprint: stableSha256(core) };
};
const loop = (name) => new ExecutionLoop({
  journal: new DurableJournal(join(root, name + '.ndjson')),
  registry,
  identity,
  now: () => 1100,
});
const rejects = async (name, plan) => {
  try {
    await loop(name).executePlan(order, plan, { timeout_ms: 100 });
    return false;
  } catch {
    return true;
  }
};

try {
  const exact = await loop('exact').executePlan(order, makePlan(), { timeout_ms: 100 });
  const badFingerprint = makePlan();
  badFingerprint.fingerprint = 'e'.repeat(64);
  const missing = await rejects('missing', undefined);
  const stale = await rejects('stale', makePlan({ order_fingerprint: 'd'.repeat(64) }));
  const invalidFingerprint = await rejects('fingerprint', badFingerprint);
  const mismatch = await loop('mismatch').executePlan(
    order,
    makePlan({ adapter_id: 'status-a' }),
    { timeout_ms: 100 },
  );
  console.log(JSON.stringify({
    exact: [exact.event.state, exact.adapter_result?.capability ?? null],
    rejected: [missing, stale, invalidFingerprint],
    mismatch: [mismatch.event.state, mismatch.adapter_result],
    calls,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
"""


class FactoryRunnerPlanAdapterLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = subprocess.check_output(
            ("node", "--experimental-strip-types", "--input-type=module", "-e", NODE),
            cwd=ROOT,
            text=True,
            timeout=20,
            stderr=subprocess.STDOUT,
        )
        cls.observed = json.loads(raw.strip().splitlines()[-1])

    def test_execution_loop_dispatches_exact_adapter_from_execution_plan(self):
        self.assertEqual(self.observed["exact"], ["completed", "git.head"])
        self.assertEqual(self.observed["calls"], ["git-a:git.head"])

    def test_missing_stale_or_mismatched_plan_blocks_before_adapter_effect(self):
        self.assertEqual(self.observed["rejected"], [True, True, True])
        self.assertEqual(self.observed["mismatch"], ["failed", None])
        self.assertEqual(self.observed["calls"], ["git-a:git.head"])


if __name__ == "__main__":
    unittest.main()
