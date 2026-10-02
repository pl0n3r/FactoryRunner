"""Aceptación de recovery browser remoto sin replay ni evidencia sensible (#179)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserExecutionAdapter } from './src/adapters/browser.ts';
import { AdapterRegistry } from './src/adapters/programmatic.ts';
import { browserLoopRequest } from './src/browser-loop-request.ts';
import { browserPlanStep } from './src/browser-plan.ts';
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { BrowserRemoteDriver } from './src/browser-remote-driver.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { createBrowserRemoteSupervisor } from './src/browser-remote-supervisor.ts';
import { browserRemoteRecoveryEvidence } from './src/browser-remote-runtime-recovery.ts';
import { ExecutionLoop } from './src/execution-loop.ts';
import { DurableJournal } from './src/journal.ts';
import { DurableOutbox } from './src/outbox.ts';
import { orderFingerprint } from './src/order.ts';
import { stableSha256 } from './src/validation.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER = '22222222-2222-7222-8222-222222222222';
const NOW = 4100;
const identity = {
  version: 1, runner_id: RUNNER, protocol_version: 1, runtime: 'node',
  runtime_version: '0.1.0', platform: 'linux-arm64',
  location: 'hostinger-shared', capabilities: ['browser.navigate'], max_parallel: 1,
};
const order = {
  version: 1, order_id: ORDER, work_item_id: 'factoryrunner:work:179',
  runner_id: RUNNER, capability: 'browser.navigate', attempt: 1,
  issued_at: 4000, expires_at: 4300, instruction_ref: 'controlbot:instruction:179',
};
const orderHash = orderFingerprint(order);

function admission() {
  const core = {
    version: 1, decision: 'ALLOW', authority: 'unchanged', runner_id: RUNNER,
    order_id: ORDER, work_item_id: order.work_item_id, observed_at: NOW,
    order_fingerprint: orderHash, manifest_fingerprint: 'b'.repeat(64),
    resource_fingerprint: 'c'.repeat(64), reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function plan(a) {
  const core = {
    version: 1, authority: 'unchanged', runner_id: RUNNER, order_id: ORDER,
    work_item_id: order.work_item_id, capability: order.capability,
    order_fingerprint: orderHash, admission_fingerprint: a.fingerprint,
    adapter_id: 'browser-execution', manifest_fingerprint: a.manifest_fingerprint,
    resource_fingerprint: a.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}
function request(p) {
  const step = browserPlanStep(order, p, {
    version: 1, adapter_id: 'browser-execution', capability: 'browser.navigate',
    payload: { url: 'https://example.com/recovery-179' },
  });
  return browserLoopRequest(order, p, { version: 1, browser_kind: 'step', browser: step });
}
function registry() {
  return new AdapterRegistry([{
    id: 'dummy-adapter', capabilities: ['git.head'],
    async execute(capability) {
      return { capability, data: Object.freeze({ unused: true }),
        evidence: { code: 'unused', summary: 'unused', ref: null } };
    },
  }]);
}
function profile() {
  return browserRemoteProfile({
    version: 1, runner_id: RUNNER, location: 'hostinger-shared',
    capability: 'browser.navigate', remote_alias: 'browser-primary',
  });
}
function placementProfile() {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER,
    observed_at: NOW,
    host_local_proven: false,
    remote_capable_proven: true,
    status: 'KNOWN',
    identity_fingerprint: stableSha256(identity),
    resource_fingerprint: 'c'.repeat(64),
    manifest_fingerprint: 'b'.repeat(64),
    evidence_fingerprint: 'd'.repeat(64),
  };
  return { ...core, fingerprint: stableSha256(core) };
}
class Transport {
  constructor(mode = 'ok') { this.mode = mode; this.calls = 0; }
  async execute(req) {
    this.calls += 1;
    if (this.mode === 'fail') throw new Error('provider-sensitive-message-179');
    if (this.mode === 'hang') return await new Promise(() => {});
    return {
      version: 1, authority: 'unchanged', request_fingerprint: req.request_fingerprint,
      status: 'ok', ref: 'browserref:remote-0179',
    };
  }
}
function client(counts) {
  return {
    async poll() {
      return { version: 1, cursor: null, orders: [{ ...order, fingerprint: orderHash }] };
    },
    validatedOrder(id) { if (id !== ORDER) throw new TypeError('unknown'); return order; },
    async ack() { counts.ack += 1; },
    async publishEvents() { counts.publish += 1; },
    async publishHeartbeat() {},
  };
}
function ids(seed) {
  let n = seed;
  return () => '99999999-9999-7999-8999-' + String(n++).padStart(12, '0');
}
function supervisor(root, transport, counts, seed) {
  const a = admission(); const p = plan(a); const directory = new BrowserRemoteDirectory();
  directory.register({ profile: profile(), transport });
  return createBrowserRemoteSupervisor({
    client: client(counts), journal: new DurableJournal(join(root, 'journal.ndjson')),
    outbox: new DurableOutbox(join(root, 'outbox.ndjson')), registry: registry(),
    identity, directory, allowed_origins: ['https://example.com'],
    admission: () => a, plan: () => p,
    placement_profile: () => placementProfile(),
    browser_request: () => request(p),
    now: () => NOW, event_id: ids(seed),
  });
}

async function terminalAndRestart() {
  const root = mkdtempSync(join(tmpdir(), 'fr179-terminal-'));
  const firstTransport = new Transport();
  const firstCounts = { ack: 0, publish: 0 };
  await supervisor(root, firstTransport, firstCounts, 1).tick(1);
  const secondTransport = new Transport();
  const secondCounts = { ack: 0, publish: 0 };
  await supervisor(root, secondTransport, secondCounts, 20).tick(1);
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const evidence = browserRemoteRecoveryEvidence(journal, outbox, ORDER);
  const raw = readFileSync(join(root, 'journal.ndjson'), 'utf8')
    + readFileSync(join(root, 'outbox.ndjson'), 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { firstCalls: firstTransport.calls, secondCalls: secondTransport.calls,
    firstCounts, secondCounts, evidence, raw };
}

async function interrupted() {
  const root = mkdtempSync(join(tmpdir(), 'fr179-interrupted-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  journal.appendOrder(order);
  journal.appendEvent({
    version: 1, event_id: '33333333-3333-7333-8333-333333333331',
    order_id: ORDER, runner_id: RUNNER, sequence: 1, state: 'accepted',
    occurred_at: 4098, evidence: { code: 'accepted', summary: 'accepted', ref: null },
  });
  journal.appendEvent({
    version: 1, event_id: '33333333-3333-7333-8333-333333333332',
    order_id: ORDER, runner_id: RUNNER, sequence: 2, state: 'started',
    occurred_at: 4099, evidence: { code: 'started', summary: 'started', ref: null },
  });
  const transport = new Transport(); const counts = { ack: 0, publish: 0 };
  await supervisor(root, transport, counts, 40).tick(1);
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const evidence = browserRemoteRecoveryEvidence(journal, outbox, ORDER);
  const raw = readFileSync(join(root, 'journal.ndjson'), 'utf8')
    + readFileSync(join(root, 'outbox.ndjson'), 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { calls: transport.calls, counts, evidence, raw };
}

async function failure(kind) {
  const root = mkdtempSync(join(tmpdir(), 'fr179-failure-'));
  const journal = new DurableJournal(join(root, 'journal.ndjson'));
  const outbox = new DurableOutbox(join(root, 'outbox.ndjson'));
  const a = admission(); const p = plan(a); const req = request(p);
  const transport = new Transport(kind === 'timeout' ? 'hang' : kind === 'failure' ? 'fail' : 'ok');
  const adapter = new BrowserExecutionAdapter(
    new BrowserRemoteDriver(profile(), transport), ['https://example.com'],
    { runner_id: RUNNER, order_id: ORDER, location: 'hostinger-shared' },
  );
  const loop = new ExecutionLoop({
    journal, registry: registry(), browser_adapter: adapter, identity,
    now: () => NOW, event_id: ids(kind === 'timeout' ? 60 : kind === 'cancel' ? 70 : 80),
  });
  const options = {};
  if (kind === 'timeout') options.timeout_ms = 1;
  if (kind === 'cancel') {
    const controller = new AbortController(); controller.abort(); options.signal = controller.signal;
  }
  const result = await loop.executeBrowserRequest(order, p, req, options);
  const evidence = browserRemoteRecoveryEvidence(journal, outbox, ORDER);
  const raw = readFileSync(join(root, 'journal.ndjson'), 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { calls: transport.calls, state: result.event.state, code: result.event.evidence.code, evidence, raw };
}

console.log(JSON.stringify({
  terminal: await terminalAndRestart(),
  interrupted: await interrupted(),
  timeout: await failure('timeout'),
  cancel: await failure('cancel'),
  failure: await failure('failure'),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT, text=True, stderr=subprocess.STDOUT, timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteRuntimeRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_interrupted_or_terminal_remote_execution_is_not_replayed(self):
        terminal = self.observed["terminal"]
        self.assertEqual(terminal["firstCalls"], 1)
        self.assertEqual(terminal["secondCalls"], 0)
        self.assertEqual(terminal["secondCounts"], {"ack": 0, "publish": 0})
        self.assertFalse(terminal["evidence"]["replay_allowed"])
        self.assertEqual(terminal["evidence"]["recovery"], "terminal")
        self.assertEqual(terminal["evidence"]["delivered_delivery_kinds"], ["ack", "plan-events"])

        interrupted = self.observed["interrupted"]
        self.assertEqual(interrupted["calls"], 0)
        self.assertFalse(interrupted["evidence"]["replay_allowed"])
        self.assertEqual(interrupted["evidence"]["recovery"], "terminal")
        self.assertEqual(interrupted["evidence"]["evidence_code"], "restart-interrupted")
        self.assertEqual(interrupted["counts"], {"ack": 1, "publish": 1})

    def test_timeout_cancel_and_failure_emit_bounded_secret_free_evidence(self):
        expected = {
            "timeout": ("failed", "timeout"),
            "cancel": ("cancelled", "cancelled"),
            "failure": ("failed", "adapter-failed"),
        }
        for key, (state, code) in expected.items():
            with self.subTest(case=key):
                item = self.observed[key]
                self.assertEqual(item["state"], state)
                self.assertEqual(item["code"], code)
                self.assertFalse(item["evidence"]["replay_allowed"])
                self.assertEqual(item["evidence"]["last_state"], state)
                self.assertEqual(item["evidence"]["evidence_code"], code)
                self.assertRegex(item["evidence"]["fingerprint"], r"^[0-9a-f]{64}$")
                raw = item["raw"].lower()
                self.assertNotIn("provider-sensitive-message-179", raw)
                self.assertNotIn("browserref:remote-0179", raw)
                self.assertNotIn("https://example.com/recovery-179", raw)


if __name__ == "__main__":
    unittest.main()
