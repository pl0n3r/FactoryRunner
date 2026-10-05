import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "fenced-execution-binding.ts"


def observe() -> dict[str, object]:
    script = r"""
import {
  assertFencedAck,
  assertFencedEvent,
  bindFencedExecution,
} from './src/controlbot/fenced-execution-binding.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const otherRunnerId = '99999999-9999-7999-8999-999999999999';
const orderId = '22222222-2222-4222-8222-222222222222';
const otherOrderId = '88888888-8888-4888-8888-888888888888';
const attemptId = '44444444-4444-7444-8444-444444444444';
const otherAttemptId = '77777777-7777-4777-8777-777777777777';
const eventId = '33333333-3333-4333-8333-333333333333';

const session = {
  version: 1,
  session_id: 'session_001',
  runner_id: runnerId,
  generation: 7,
  scope: 'factoryrunner',
};

const poll = {
  version: 1,
  method: 'POST',
  path: '/v1/runner/poll',
  payload: {
    version: 1,
    runner_id: runnerId,
    session_id: 'session_001',
    generation: 7,
    requested_at: 1000,
  },
};

const controlOrder = {
  version: 1,
  order_id: orderId,
  attempt_id: attemptId,
  generation: 7,
  work_item_id: 'factoryrunner:issue:416',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  scope: 'factoryrunner',
  issued_at: 900,
  expires_at: 1200,
  instruction_ref: 'controlbot:instruction:416',
};

const internalOrder = {
  version: 1,
  order_id: orderId,
  work_item_id: 'factoryrunner:issue:416',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  issued_at: 900,
  expires_at: 1200,
  instruction_ref: 'controlbot:instruction:416',
};

const ack = {
  version: 1,
  method: 'POST',
  path: '/v1/runner/ack',
  payload: {
    version: 1,
    order_id: orderId,
    attempt_id: attemptId,
    runner_id: runnerId,
    generation: 7,
    acknowledged_at: 1001,
  },
};

const event = {
  version: 1,
  method: 'POST',
  path: '/v1/runner/event',
  payload: {
    version: 1,
    event_id: eventId,
    order_id: orderId,
    attempt_id: attemptId,
    runner_id: runnerId,
    generation: 7,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1002,
    evidence: {
      code: 'accepted',
      summary: 'accepted by runner',
      ref: 'controlbot:evidence:accepted',
    },
  },
};

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const bindingA = bindFencedExecution(session, poll, controlOrder, internalOrder);
const bindingB = bindFencedExecution(session, poll, controlOrder, internalOrder);
const ackOutcome = assertFencedAck(bindingA, ack);
const eventOutcome = assertFencedEvent(bindingA, event);

const bindRejected = {
  stale_generation: rejected(() => bindFencedExecution(
    { ...session, generation: 8 },
    poll,
    controlOrder,
    internalOrder,
  )),
  foreign_runner: rejected(() => bindFencedExecution(
    { ...session, runner_id: otherRunnerId },
    poll,
    controlOrder,
    internalOrder,
  )),
  foreign_session: rejected(() => bindFencedExecution(
    { ...session, session_id: 'session_002' },
    poll,
    controlOrder,
    internalOrder,
  )),
  scope_mismatch: rejected(() => bindFencedExecution(
    { ...session, scope: 'another-project' },
    poll,
    controlOrder,
    internalOrder,
  )),
  mixed_internal_order: rejected(() => bindFencedExecution(
    session,
    poll,
    controlOrder,
    { ...internalOrder, work_item_id: 'factoryrunner:issue:999' },
  )),
};

const outcomeRejected = {
  ack_attempt: rejected(() => assertFencedAck(bindingA, {
    ...ack,
    payload: { ...ack.payload, attempt_id: otherAttemptId },
  })),
  ack_runner: rejected(() => assertFencedAck(bindingA, {
    ...ack,
    payload: { ...ack.payload, runner_id: otherRunnerId },
  })),
  event_generation: rejected(() => assertFencedEvent(bindingA, {
    ...event,
    payload: { ...event.payload, generation: 8 },
  })),
  event_order: rejected(() => assertFencedEvent(bindingA, {
    ...event,
    payload: { ...event.payload, order_id: otherOrderId },
  })),
  tampered_scope: rejected(() => assertFencedAck(
    { ...bindingA, scope: 'another-project' },
    ack,
  )),
  tampered_session: rejected(() => assertFencedEvent(
    { ...bindingA, session_id: 'session_002' },
    event,
  )),
};

console.log(JSON.stringify({
  binding_a: bindingA,
  binding_b: bindingB,
  ack_outcome: ackOutcome,
  event_outcome: eventOutcome,
  bind_rejected: bindRejected,
  outcome_rejected: outcomeRejected,
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerControlBotFencedExecutionBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_binding_preserves_session_generation_attempt_scope_runner_and_order_identity(self):
        binding = self.observed["binding_a"]
        self.assertEqual(binding["session_id"], "session_001")
        self.assertEqual(binding["generation"], 7)
        self.assertEqual(binding["attempt_id"], "44444444-4444-7444-8444-444444444444")
        self.assertEqual(binding["scope"], "factoryrunner")
        self.assertEqual(binding["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertEqual(binding["order_id"], "22222222-2222-4222-8222-222222222222")
        self.assertEqual(binding["work_item_id"], "factoryrunner:issue:416")
        self.assertRegex(binding["internal_order_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(binding["binding_fingerprint"], r"^[0-9a-f]{64}$")

    def test_stale_foreign_or_mixed_generation_attempt_scope_fails_closed(self):
        for name, rejected in self.observed["bind_rejected"].items():
            with self.subTest(case=name):
                self.assertTrue(rejected)
        self.assertTrue(self.observed["outcome_rejected"]["ack_attempt"])
        self.assertTrue(self.observed["outcome_rejected"]["event_generation"])
        self.assertTrue(self.observed["outcome_rejected"]["tampered_scope"])
        self.assertTrue(self.observed["outcome_rejected"]["tampered_session"])

    def test_ack_and_event_context_must_match_exact_bound_execution_before_outcome(self):
        ack = self.observed["ack_outcome"]
        event = self.observed["event_outcome"]
        self.assertEqual(ack["kind"], "ack")
        self.assertEqual(event["kind"], "event")
        self.assertEqual(ack["binding_fingerprint"], self.observed["binding_a"]["binding_fingerprint"])
        self.assertEqual(event["binding_fingerprint"], self.observed["binding_a"]["binding_fingerprint"])
        self.assertEqual(ack["scope"], "factoryrunner")
        self.assertEqual(event["session_id"], "session_001")

        for name, rejected in self.observed["outcome_rejected"].items():
            with self.subTest(case=name):
                self.assertTrue(rejected)

    def test_binding_is_deterministic_local_secret_free_and_non_executing(self):
        self.assertEqual(self.observed["binding_a"], self.observed["binding_b"])
        for key in ("binding_a", "ack_outcome", "event_outcome"):
            value = self.observed[key]
            self.assertEqual(value["authority"], "unchanged")
            self.assertFalse(value["execution"])
            self.assertFalse(value["network_access"])
            self.assertFalse(value["external_mutation"])
            serialized = json.dumps(value, sort_keys=True)
            for forbidden in (
                "instruction_ref",
                "controlbot:instruction",
                "password",
                "token",
                "secret",
            ):
                self.assertNotIn(forbidden, serialized.lower())

        self.assertIn("controlBotRunnerHttpRequest", self.source)
        self.assertIn("parseExecutionOrder", self.source)
        self.assertIn("orderFingerprint", self.source)
        for forbidden in (
            "fetch(",
            "node:http",
            "node:https",
            "node:net",
            "node:fs",
            "node:child_process",
            "process.env",
            "Authorization",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
