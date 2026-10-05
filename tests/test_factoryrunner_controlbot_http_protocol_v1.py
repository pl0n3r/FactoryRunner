import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "http-protocol-v1.ts"


def observe() -> dict[str, object]:
    script = r"""
import { controlBotRunnerHttpRequest } from './src/controlbot/http-protocol-v1.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-7444-8444-444444444444';

const envelope = (path, payload) => ({
  version: 1,
  method: 'POST',
  path,
  payload,
});

const valid = [
  envelope('/v1/runner/heartbeat', {
    version: 1,
    runner_id: runnerId,
    sequence: 1,
    observed_at: 1000,
    status: 'ready',
    capacity: { max: 2, active: 0 },
    active_sessions: [],
  }),
  envelope('/v1/runner/poll', {
    version: 1,
    runner_id: runnerId,
    session_id: 'session_001',
    generation: 7,
    requested_at: 1001,
  }),
  envelope('/v1/runner/ack', {
    version: 1,
    order_id: orderId,
    attempt_id: attemptId,
    runner_id: runnerId,
    generation: 7,
    acknowledged_at: 1002,
  }),
  envelope('/v1/runner/event', {
    version: 1,
    event_id: eventId,
    order_id: orderId,
    attempt_id: attemptId,
    runner_id: runnerId,
    generation: 7,
    sequence: 1,
    state: 'accepted',
    occurred_at: 1003,
    evidence: {
      code: 'accepted',
      summary: 'accepted by runner',
      ref: 'controlbot:evidence:accepted',
    },
  }),
];

function rejected(candidate) {
  try {
    controlBotRunnerHttpRequest(candidate);
    return false;
  } catch {
    return true;
  }
}

const legacy = {
  poll_cursor_limit: envelope('/v1/runner/poll', {
    version: 1,
    runner_id: runnerId,
    capabilities: ['git.head'],
    cursor: null,
    limit: 10,
  }),
  ack_fingerprint: envelope('/v1/runner/ack', {
    version: 1,
    order_id: orderId,
    runner_id: runnerId,
    fingerprint: 'a'.repeat(64),
  }),
  unknown_top: { ...valid[1], debug: true },
  unknown_payload: envelope('/v1/runner/poll', {
    ...valid[1].payload,
    debug: true,
  }),
  wrong_method: { ...valid[1], method: 'GET' },
  wrong_path: { ...valid[1], path: '/v1/runner/unknown' },
  wrong_version: { ...valid[1], version: 2 },
};

const unsafe = {
  secret_field: envelope('/v1/runner/poll', {
    ...valid[1].payload,
    api_token: 'opaque-value',
  }),
  secret_value: envelope('/v1/runner/poll', {
    ...valid[1].payload,
    session_id: 'token=supersecretvalue',
  }),
  oversized_payload: envelope('/v1/runner/event', {
    ...valid[3].payload,
    evidence: {
      ...valid[3].payload.evidence,
      summary: 'x'.repeat(33_000),
    },
  }),
  too_many_sessions: envelope('/v1/runner/heartbeat', {
    ...valid[0].payload,
    capacity: { max: 64, active: 64 },
    active_sessions: Array.from({ length: 65 }, (_, index) => `session_${index}`),
  }),
  mixed_generation: envelope('/v1/runner/ack', {
    ...valid[2].payload,
    generation: 0,
  }),
};

console.log(JSON.stringify({
  valid: valid.map(controlBotRunnerHttpRequest),
  legacy_rejected: Object.fromEntries(
    Object.entries(legacy).map(([name, candidate]) => [name, rejected(candidate)]),
  ),
  unsafe_rejected: Object.fromEntries(
    Object.entries(unsafe).map(([name, candidate]) => [name, rejected(candidate)]),
  ),
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerControlBotHttpProtocolV1Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_routes_and_payload_shapes_match_controlbot_runner_http_protocol_v1(self):
        heartbeat, poll, ack, event = self.observed["valid"]
        self.assertEqual(
            [item["path"] for item in self.observed["valid"]],
            [
                "/v1/runner/heartbeat",
                "/v1/runner/poll",
                "/v1/runner/ack",
                "/v1/runner/event",
            ],
        )

        self.assertEqual(
            set(heartbeat["payload"]),
            {
                "version",
                "runner_id",
                "sequence",
                "observed_at",
                "status",
                "capacity",
                "active_sessions",
            },
        )
        self.assertEqual(
            set(poll["payload"]),
            {"version", "runner_id", "session_id", "generation", "requested_at"},
        )
        self.assertEqual(
            set(ack["payload"]),
            {
                "version",
                "order_id",
                "attempt_id",
                "runner_id",
                "generation",
                "acknowledged_at",
            },
        )
        self.assertEqual(
            set(event["payload"]),
            {
                "version",
                "event_id",
                "order_id",
                "attempt_id",
                "runner_id",
                "generation",
                "sequence",
                "state",
                "occurred_at",
                "evidence",
            },
        )
        self.assertEqual(poll["payload"]["session_id"], "session_001")
        self.assertEqual(ack["payload"]["attempt_id"], "44444444-4444-7444-8444-444444444444")
        self.assertEqual(event["payload"]["generation"], 7)

    def test_legacy_cursor_limit_fingerprint_or_unknown_extra_fields_fail_closed(self):
        for name, rejected in self.observed["legacy_rejected"].items():
            with self.subTest(case=name):
                self.assertTrue(rejected)

    def test_payload_and_envelope_bounds_and_secret_material_fail_closed(self):
        for name, rejected in self.observed["unsafe_rejected"].items():
            with self.subTest(case=name):
                self.assertTrue(rejected)
        self.assertIn("MAX_ENVELOPE_BYTES = 65_536", self.source)
        self.assertIn("MAX_PAYLOAD_BYTES = 32_768", self.source)
        self.assertIn("SECRET_KEY_RE", self.source)

    def test_contract_has_no_network_execution_or_external_mutation_authority(self):
        for result in self.observed["valid"]:
            self.assertEqual(result["authority"], "unchanged")
            self.assertFalse(result["execution"])
            self.assertFalse(result["network_access"])
            self.assertFalse(result["external_mutation"])

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
