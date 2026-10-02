"""Aceptación ejecutable de AdmissionEvidence FactoryRunner #98."""
from __future__ import annotations

import json
import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

COMMON = r"""
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { admissionEvidence } = await import(
  pathToFileURL(root + '/src/admission-evidence.ts').href
);
const { executionAdmissionDecision } = await import(
  pathToFileURL(root + '/src/execution-admission.ts').href
);
const { capabilityManifest } = await import(
  pathToFileURL(root + '/src/capability-manifest.ts').href
);

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

const identity = {
  version: 1,
  runner_id: runnerId,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'hostinger-shared',
  capabilities: ['git.head'],
  max_parallel: 2,
};

const order = {
  version: 1,
  order_id: orderId,
  work_item_id: 'factoryrunner:work:98',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1_100,
  expires_at: 1_500,
  instruction_ref: 'controlbot:instruction:factoryrunner-98',
};

const adapters = [{ id: 'git-read', capabilities: ['git.head'] }];
const manifest = capabilityManifest(identity, adapters);

function resource(overrides = {}) {
  return {
    version: 1,
    runner_id: runnerId,
    observed_at: 1_200,
    heartbeat_sequence: 10,
    runner_status: 'ready',
    max_parallel: 2,
    active: 0,
    available: 2,
    queued_orders: 1,
    dispatchable_orders: 1,
    freshness: 'fresh',
    age_seconds: 15,
    stale_after_seconds: 30,
    ...overrides,
  };
}
"""


def run_node(body: str) -> dict[str, object]:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            textwrap.dedent(COMMON + "\n" + body),
        ],
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


class FactoryRunnerAdmissionEvidenceTests(unittest.TestCase):
    def test_evidence_links_order_manifest_resource_and_decision_without_raw_payloads(self):
        result = run_node(
            r"""
const decision = executionAdmissionDecision(
  identity,
  order,
  manifest,
  resource(),
  1_215,
);
assert.equal(decision.decision, 'ALLOW');

const evidence = admissionEvidence(decision);
assert.equal(evidence.version, 1);
assert.equal(evidence.decision, 'ALLOW');
assert.equal(evidence.authority, 'unchanged');
assert.equal(evidence.runner_id, runnerId);
assert.equal(evidence.order_id, orderId);
assert.equal(evidence.work_item_id, 'factoryrunner:work:98');
assert.equal(evidence.observed_at, 1_200);
assert.equal(evidence.order_fingerprint, decision.order_fingerprint);
assert.equal(evidence.manifest_fingerprint, decision.manifest_fingerprint);
assert.equal(evidence.resource_fingerprint, decision.resource_fingerprint);
assert.equal(evidence.decision_fingerprint, decision.fingerprint);
assert.deepEqual(evidence.reasons, ['admission_evidence_coherent']);
assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/);
assert.ok(Object.isFrozen(evidence));
assert.ok(Object.isFrozen(evidence.reasons));

const serialized = JSON.stringify(evidence);
for (const forbidden of [
  'instruction_ref',
  'controlbot:instruction:factoryrunner-98',
  'capability',
  'git.head',
  'adapters',
  'payload',
  'metrics',
]) {
  assert.ok(!serialized.includes(forbidden), forbidden);
}

assert.throws(
  () => admissionEvidence({ ...decision, raw_payload: { token: 'secret' } }),
  /campos inválidos/,
);
assert.throws(
  () => admissionEvidence({ ...decision, work_item_id: 'token:supersecretvalue' }),
  /sensible/,
);
assert.throws(
  () => admissionEvidence({
    ...decision,
    reasons: Array.from({ length: 17 }, (_, index) => 'reason_' + index),
  }),
  /reasons inválidas/,
);

console.log(JSON.stringify({ pass: true, fingerprint: evidence.fingerprint }));
"""
        )
        self.assertTrue(result["pass"])
        self.assertRegex(str(result["fingerprint"]), r"^[0-9a-f]{64}$")

    def test_drift_or_freshness_change_never_rewrites_or_escalates_admission_authority(self):
        result = run_node(
            r"""
const originalDecision = executionAdmissionDecision(
  identity,
  order,
  manifest,
  resource(),
  1_215,
);
const historical = admissionEvidence(originalDecision);
const historicalJson = JSON.stringify(historical);

const staleDecision = executionAdmissionDecision(
  identity,
  order,
  manifest,
  resource({
    observed_at: 1_000,
    age_seconds: 215,
  }),
  1_215,
);
assert.equal(staleDecision.decision, 'BLOCKED');
const staleEvidence = admissionEvidence(staleDecision);
assert.equal(staleEvidence.decision, 'BLOCKED');
assert.equal(staleEvidence.authority, 'unchanged');
assert.equal(JSON.stringify(historical), historicalJson);

const driftManifest = {
  ...manifest,
  runner_id: '33333333-3333-7333-8333-333333333333',
};
const driftDecision = executionAdmissionDecision(
  identity,
  order,
  driftManifest,
  resource(),
  1_215,
);
assert.equal(driftDecision.decision, 'BLOCKED');
const driftEvidence = admissionEvidence(driftDecision);
assert.equal(driftEvidence.decision, 'BLOCKED');
assert.equal(driftEvidence.authority, 'unchanged');
assert.equal(JSON.stringify(historical), historicalJson);

const repeated = admissionEvidence(originalDecision);
assert.equal(repeated.fingerprint, historical.fingerprint);
assert.equal(repeated.decision_fingerprint, historical.decision_fingerprint);

assert.throws(
  () => historical.reasons.push('authority_escalated'),
  TypeError,
);
assert.throws(
  () => admissionEvidence({ ...originalDecision, authority: 'expanded' }),
  /authority no puede ampliarse/,
);
assert.equal(historical.authority, 'unchanged');
assert.equal(historical.decision, 'ALLOW');

console.log(JSON.stringify({
  pass: true,
  historical: historical.fingerprint,
  stale: staleEvidence.fingerprint,
  drift: driftEvidence.fingerprint,
}));
"""
        )
        self.assertTrue(result["pass"])
        self.assertRegex(str(result["historical"]), r"^[0-9a-f]{64}$")
        self.assertRegex(str(result["stale"]), r"^[0-9a-f]{64}$")
        self.assertRegex(str(result["drift"]), r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
