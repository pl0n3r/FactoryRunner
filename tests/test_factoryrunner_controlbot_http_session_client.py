import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "http-session-client.ts"


def observe() -> dict[str, object]:
    script = r"""
import { ControlBotHttpSessionClient } from './src/controlbot/http-session-client.ts';
import { bindFencedExecution } from './src/controlbot/fenced-execution-binding.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const attemptId = '44444444-4444-7444-8444-444444444444';
const eventId = '33333333-3333-4333-8333-333333333333';

const session = {
  version: 1,
  session_id: 'session_001',
  runner_id: runnerId,
  generation: 7,
  scope: 'factoryrunner',
};

const pollEnvelope = {
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
  work_item_id: 'factoryrunner:issue:417',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  scope: 'factoryrunner',
  issued_at: 900,
  expires_at: 1200,
  instruction_ref: 'controlbot:instruction:417',
};

const internalOrder = {
  version: 1,
  order_id: orderId,
  work_item_id: 'factoryrunner:issue:417',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  issued_at: 900,
  expires_at: 1200,
  instruction_ref: 'controlbot:instruction:417',
};

const binding = bindFencedExecution(session, pollEnvelope, controlOrder, internalOrder);

const pollPayload = pollEnvelope.payload;
const ackPayload = {
  version: 1,
  order_id: orderId,
  attempt_id: attemptId,
  runner_id: runnerId,
  generation: 7,
  acknowledged_at: 1001,
};
const eventPayload = {
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
};

const calls = [];
const transport = async (request) => {
  calls.push(request);
  return {
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: {
      version: 1,
      ok: true,
      path: request.envelope.path,
    },
  };
};

const client = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 4096,
  test_transport: transport,
});

const pollResult = await client.poll(pollPayload);
const ackResult = await client.ack(binding, ackPayload);
const eventResult = await client.event(binding, eventPayload);
const callsBeforeInvalidBinding = calls.length;

let invalidBindingRejected = false;
try {
  await client.ack({ ...binding, attempt_id: '77777777-7777-4777-8777-777777777777' }, ackPayload);
} catch {
  invalidBindingRejected = true;
}

let invalidEventRejected = false;
try {
  await client.event(binding, { ...eventPayload, generation: 8 });
} catch {
  invalidEventRejected = true;
}

const callsAfterInvalidBinding = calls.length;

const disabled = new ControlBotHttpSessionClient();
let disabledCode = null;
try {
  await disabled.poll(pollPayload);
} catch (error) {
  disabledCode = error?.code ?? null;
}

function constructorRejected(options) {
  try {
    new ControlBotHttpSessionClient(options);
    return false;
  } catch {
    return true;
  }
}

async function rejectedBy(clientInstance, action) {
  try {
    await action(clientInstance);
    return false;
  } catch {
    return true;
  }
}

const timeoutClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 10,
  max_response_bytes: 1024,
  test_transport: async () => new Promise(() => {}),
});
let timeoutCode = null;
try {
  await timeoutClient.poll(pollPayload);
} catch (error) {
  timeoutCode = error?.code ?? null;
}

const oversizedClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 256,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: { data: 'x'.repeat(1000) },
  }),
});

const mixedClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 1024,
  test_transport: async () => ({
    version: 1,
    request_fingerprint: 'a'.repeat(64),
    status: 200,
    body: { ok: true },
  }),
});

const invalidStatusClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 1024,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 500,
    body: { ok: false },
  }),
});

const extraFieldClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 1024,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: { ok: true },
    debug: true,
  }),
});

const arrayBodyClient = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  max_response_bytes: 1024,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: [],
  }),
});

console.log(JSON.stringify({
  status: client.status(),
  disabled_status: disabled.status(),
  poll_result: pollResult,
  ack_result: ackResult,
  event_result: eventResult,
  calls,
  calls_before_invalid_binding: callsBeforeInvalidBinding,
  calls_after_invalid_binding: callsAfterInvalidBinding,
  invalid_binding_rejected: invalidBindingRejected,
  invalid_event_rejected: invalidEventRejected,
  disabled_code: disabledCode,
  constructor_rejected: {
    enabled_without_test_mode: constructorRejected({
      enabled: true,
      test_transport: transport,
    }),
    enabled_without_transport: constructorRejected({
      enabled: true,
      test_mode: true,
    }),
    disabled_with_transport: constructorRejected({
      enabled: false,
      test_transport: transport,
    }),
    extra_option: constructorRejected({
      debug: true,
    }),
  },
  timeout_code: timeoutCode,
  response_rejected: {
    oversized: await rejectedBy(oversizedClient, (value) => value.poll(pollPayload)),
    mixed: await rejectedBy(mixedClient, (value) => value.poll(pollPayload)),
    invalid_status: await rejectedBy(invalidStatusClient, (value) => value.poll(pollPayload)),
    extra_field: await rejectedBy(extraFieldClient, (value) => value.poll(pollPayload)),
    array_body: await rejectedBy(arrayBodyClient, (value) => value.poll(pollPayload)),
  },
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerControlBotHttpSessionClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_client_uses_only_v1_contract_and_fenced_binding_before_ack_or_event(self):
        calls = self.observed["calls"]
        self.assertEqual(
            [call["envelope"]["path"] for call in calls],
            ["/v1/runner/poll", "/v1/runner/ack", "/v1/runner/event"],
        )
        for call in calls:
            self.assertEqual(call["version"], 1)
            self.assertEqual(call["envelope"]["version"], 1)
            self.assertEqual(call["envelope"]["method"], "POST")
            self.assertRegex(call["request_fingerprint"], r"^[0-9a-f]{64}$")

        self.assertTrue(self.observed["invalid_binding_rejected"])
        self.assertTrue(self.observed["invalid_event_rejected"])
        self.assertEqual(
            self.observed["calls_before_invalid_binding"],
            self.observed["calls_after_invalid_binding"],
        )
        self.assertIn("controlBotRunnerHttpRequest", self.source)
        self.assertIn("assertFencedAck", self.source)
        self.assertIn("assertFencedEvent", self.source)

    def test_client_is_disabled_by_default_and_never_resolves_real_endpoint_or_credentials(self):
        status = self.observed["disabled_status"]
        self.assertFalse(status["enabled"])
        self.assertEqual(status["transport_mode"], "disabled")
        self.assertEqual(self.observed["disabled_code"], "client_disabled")
        for rejected in self.observed["constructor_rejected"].values():
            self.assertTrue(rejected)

        for forbidden in (
            "http://",
            "https://",
            "authorization",
            "bearer ",
            "process.env",
            "globalThis.fetch",
            "fetch(",
            "headers:",
            "cookie",
        ):
            self.assertNotIn(forbidden, self.source.lower())

    def test_timeout_oversized_invalid_or_mixed_response_fails_closed_with_fake_fetch(self):
        self.assertEqual(self.observed["timeout_code"], "transport_timeout")
        for name, rejected in self.observed["response_rejected"].items():
            with self.subTest(case=name):
                self.assertTrue(rejected)
        self.assertIn("MAX_TIMEOUT_MS = 30_000", self.source)
        self.assertIn("MAX_RESPONSE_BYTES = 65_536", self.source)
        self.assertIn("request_fingerprint", self.source)

    def test_acceptance_has_no_external_network_runtime_wiring_or_mutation_authority(self):
        status = self.observed["status"]
        self.assertTrue(status["enabled"])
        self.assertEqual(status["transport_mode"], "injected_test_only")
        for key in ("status", "poll_result", "ack_result", "event_result"):
            value = self.observed[key]
            self.assertEqual(value["authority"], "unchanged")
            self.assertFalse(value["execution"])
            self.assertFalse(value["network_access"])
            self.assertFalse(value["external_mutation"])

        for result_key in ("poll_result", "ack_result", "event_result"):
            result = self.observed[result_key]
            self.assertEqual(result["transport_mode"], "injected_test_only")
            self.assertRegex(result["request_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertRegex(result["response_fingerprint"], r"^[0-9a-f]{64}$")

        for forbidden in (
            "RuntimeSupervisor",
            "ControlBotClient",
            "node:http",
            "node:https",
            "node:net",
            "node:child_process",
            "process.env",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
