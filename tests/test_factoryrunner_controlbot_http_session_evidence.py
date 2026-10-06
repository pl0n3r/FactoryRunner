import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "src" / "controlbot" / "http-session-evidence.ts"


class FactoryRunnerControlBotHttpSessionEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = EVIDENCE.read_text(encoding="utf-8")

    @staticmethod
    def _node(script):
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"node exit {completed.returncode}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return json.loads(completed.stdout)

    def test_success_evidence_preserves_only_safe_http_identity_and_fingerprints(self):
        result = self._node("""
import { ControlBotHttpSessionClient } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
const client = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  test_transport: async (request) => ({
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: { accepted: true, private_payload: 'must-not-be-copied' },
  }),
});
const sessionResult = await client.poll({
  version: 1,
  runner_id: '123e4567-e89b-12d3-a456-426614174000',
  session_id: 'session-1',
  generation: 1,
  requested_at: 1,
});
console.log(JSON.stringify(httpSessionEvidence(sessionResult)));
""")
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["outcome"], "http_success")
        self.assertEqual(result["path"], "/v1/runner/poll")
        self.assertEqual(result["status"], 200)
        self.assertRegex(result["request_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(result["response_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(result["evidence_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            set(result),
            {
                "version", "outcome", "path", "status", "request_fingerprint",
                "response_fingerprint", "evidence_fingerprint", "authority",
                "execution", "network_access", "external_mutation",
            },
        )
        self.assertNotIn("private_payload", json.dumps(result))
        self.assertNotIn("must-not-be-copied", json.dumps(result))

    def test_client_disabled_timeout_and_transport_failure_are_generic_secret_free_evidence(self):
        result = self._node("""
import { ControlBotHttpSessionClient } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
const payload = {
  version: 1,
  runner_id: '123e4567-e89b-12d3-a456-426614174000',
  session_id: 'session-1',
  generation: 1,
  requested_at: 1,
};
const cases = [
  new ControlBotHttpSessionClient(),
  new ControlBotHttpSessionClient({
    enabled: true,
    test_mode: true,
    timeout_ms: 10,
    test_transport: async () => await new Promise(() => {}),
  }),
  new ControlBotHttpSessionClient({
    enabled: true,
    test_mode: true,
    test_transport: async () => { throw new Error('authorization=Bearer ultra-secret-token'); },
  }),
];
const evidence = [];
for (const client of cases) {
  try {
    await client.poll(payload);
    throw new Error('expected client error');
  } catch (error) {
    evidence.push(httpSessionEvidence(error));
  }
}
console.log(JSON.stringify(evidence));
""")
        self.assertEqual(
            [item["outcome"] for item in result],
            ["client_disabled", "transport_timeout", "transport_failed"],
        )
        for item in result:
            self.assertEqual(
                set(item),
                {
                    "version", "outcome", "evidence_fingerprint", "authority",
                    "execution", "network_access", "external_mutation",
                },
            )
            serialized = json.dumps(item).lower()
            for forbidden in ("authorization", "bearer", "secret", "token", "cookie", "body"):
                self.assertNotIn(forbidden, serialized)

    def test_unknown_extra_mixed_or_raw_body_input_fails_closed(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { stableSha256 } from './src/validation.ts';
const body = { accepted: true };
const valid = {
  version: 1,
  path: '/v1/runner/poll',
  status: 200,
  request_fingerprint: 'a'.repeat(64),
  response_fingerprint: stableSha256(body),
  body,
  transport_mode: 'injected_test_only',
  authority: 'unchanged',
  execution: false,
  network_access: false,
  external_mutation: false,
};
const cases = [
  { accepted: true },
  { ...valid, extra: 'mixed' },
  { ...valid, body: { accepted: false } },
  { name: 'HttpSessionClientError', code: 'client_disabled' },
  new Error('transport_failed'),
  new HttpSessionClientError('transport_failed'),
];
const outcomes = cases.map((value, index) => {
  try {
    const evidence = httpSessionEvidence(value);
    return { index, accepted: true, outcome: evidence.outcome };
  } catch {
    return { index, accepted: false };
  }
});
console.log(JSON.stringify(outcomes));
""")
        self.assertEqual(
            result,
            [
                {"index": 0, "accepted": False},
                {"index": 1, "accepted": False},
                {"index": 2, "accepted": False},
                {"index": 3, "accepted": False},
                {"index": 4, "accepted": False},
                {"index": 5, "accepted": True, "outcome": "transport_failed"},
            ],
        )

    def test_error_code_is_read_once_before_allowlist_decision(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
const error = new HttpSessionClientError('transport_failed');
let reads = 0;
Object.defineProperty(error, 'code', {
  configurable: true,
  get() {
    reads += 1;
    return reads === 1 ? 'transport_failed' : 'authorization=Bearer mutable-secret';
  },
});
const evidence = httpSessionEvidence(error);
console.log(JSON.stringify({ reads, outcome: evidence.outcome, evidence }));
""")
        self.assertEqual(result["reads"], 1)
        self.assertEqual(result["outcome"], "transport_failed")
        serialized = json.dumps(result["evidence"]).lower()
        for forbidden in ("authorization", "bearer", "secret", "token"):
            self.assertNotIn(forbidden, serialized)

    def test_evidence_is_deterministic_local_bounded_and_non_executing(self):
        result = self._node("""
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { stableSha256 } from './src/validation.ts';
const body = { accepted: true, sequence: 7 };
const input = Object.freeze({
  version: 1,
  path: '/v1/runner/heartbeat',
  status: 204,
  request_fingerprint: 'b'.repeat(64),
  response_fingerprint: stableSha256(body),
  body: Object.freeze(body),
  transport_mode: 'injected_test_only',
  authority: 'unchanged',
  execution: false,
  network_access: false,
  external_mutation: false,
});
const first = httpSessionEvidence(input);
const second = httpSessionEvidence(input);
console.log(JSON.stringify({
  equal: JSON.stringify(first) === JSON.stringify(second),
  frozen: Object.isFrozen(first),
  bytes: new TextEncoder().encode(JSON.stringify(first)).byteLength,
  first,
}));
""")
        self.assertIs(result["equal"], True)
        self.assertIs(result["frozen"], True)
        self.assertLessEqual(result["bytes"], 1024)
        self.assertEqual(result["first"]["authority"], "unchanged")
        self.assertIs(result["first"]["execution"], False)
        self.assertIs(result["first"]["network_access"], False)
        self.assertIs(result["first"]["external_mutation"], False)
        lowered = self.source.lower()
        for forbidden in (
            "node:http", "node:https", "fetch(", "axios", "curl ", "wget ",
            "process.env", "writefile", "appendfile",
        ):
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
