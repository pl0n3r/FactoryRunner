import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "http-session-abort.ts"


class FactoryRunnerControlBotHttpSessionAbortTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")

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

    def test_external_abort_signal_is_canonical_local_and_request_fingerprint_bound(self):
        result = self._node("""
import { HttpSessionAbortContract } from './src/controlbot/http-session-abort.ts';
const controller = new AbortController();
const contract = new HttpSessionAbortContract({
  request_fingerprint: 'a'.repeat(64),
  signal: controller.signal,
});
const first = contract.snapshot();
controller.abort('authorization=Bearer must-never-appear');
const second = contract.snapshot();
console.log(JSON.stringify({
  first,
  second,
  contract_frozen: Object.isFrozen(contract),
  first_frozen: Object.isFrozen(first),
  second_frozen: Object.isFrozen(second),
}));
""")
        self.assertEqual(result["first"]["request_fingerprint"], "a" * 64)
        self.assertIs(result["first"]["aborted"], False)
        self.assertEqual(result["first"]["abort_phase"], "none")
        self.assertIs(result["second"]["aborted"], True)
        self.assertEqual(result["second"]["abort_phase"], "in_flight")
        self.assertEqual(
            set(result["second"]),
            {
                "version", "request_fingerprint", "aborted", "abort_phase",
                "authority", "execution", "network_access", "external_mutation",
            },
        )
        self.assertEqual(result["second"]["authority"], "unchanged")
        self.assertIs(result["second"]["execution"], False)
        self.assertIs(result["second"]["network_access"], False)
        self.assertIs(result["second"]["external_mutation"], False)
        self.assertIs(result["contract_frozen"], True)
        self.assertIs(result["first_frozen"], True)
        self.assertIs(result["second_frozen"], True)
        serialized = json.dumps(result).lower()
        for forbidden in ("authorization", "bearer", "must-never-appear"):
            self.assertNotIn(forbidden, serialized)

    def test_pre_aborted_and_in_flight_abort_are_distinct_and_fail_closed(self):
        result = self._node("""
import { HttpSessionAbortContract } from './src/controlbot/http-session-abort.ts';
const pre = new AbortController();
pre.abort('pre-secret');
const preContract = new HttpSessionAbortContract({
  request_fingerprint: 'b'.repeat(64),
  signal: pre.signal,
});
const live = new AbortController();
const liveContract = new HttpSessionAbortContract({
  request_fingerprint: 'c'.repeat(64),
  signal: live.signal,
});
const before = liveContract.snapshot();
live.abort('late-secret');
console.log(JSON.stringify({
  pre_first: preContract.snapshot(),
  pre_second: preContract.snapshot(),
  before,
  in_flight_first: liveContract.snapshot(),
  in_flight_second: liveContract.snapshot(),
}));
""")
        self.assertEqual(result["pre_first"]["abort_phase"], "pre_dispatch")
        self.assertEqual(result["pre_second"]["abort_phase"], "pre_dispatch")
        self.assertIs(result["pre_first"]["aborted"], True)
        self.assertEqual(result["before"]["abort_phase"], "none")
        self.assertEqual(result["in_flight_first"]["abort_phase"], "in_flight")
        self.assertEqual(result["in_flight_second"]["abort_phase"], "in_flight")
        self.assertIs(result["in_flight_first"]["aborted"], True)

    def test_invalid_extra_or_non_signal_input_is_rejected_without_payload_or_secret_material(self):
        result = self._node("""
import { HttpSessionAbortContract } from './src/controlbot/http-session-abort.ts';
const validSignal = new AbortController().signal;
const cases = [
  null,
  {},
  { request_fingerprint: 'x', signal: validSignal },
  { request_fingerprint: 'd'.repeat(64), signal: {} },
  { request_fingerprint: 'd'.repeat(64), signal: { [Symbol.toStringTag]: 'AbortSignal', aborted: false } },
  { request_fingerprint: 'd'.repeat(64), signal: validSignal, payload: { token: 'secret' } },
];
const rejected = cases.map((value) => {
  try {
    new HttpSessionAbortContract(value);
    return false;
  } catch {
    return true;
  }
});
console.log(JSON.stringify(rejected));
""")
        self.assertEqual(result, [True, True, True, True, True, True])
        lowered = self.source.lower()
        for forbidden in ("payload", ".reason", "authorization", "bearer ", "cookie", "token"):
            self.assertNotIn(forbidden, lowered)

    def test_abort_contract_has_no_retry_network_endpoint_auth_runtime_or_external_mutation_authority(self):
        result = self._node("""
import { HttpSessionAbortContract } from './src/controlbot/http-session-abort.ts';
const controller = new AbortController();
const contract = new HttpSessionAbortContract({
  request_fingerprint: 'e'.repeat(64),
  signal: controller.signal,
});
const first = contract.snapshot();
const second = contract.snapshot();
console.log(JSON.stringify({
  deterministic: JSON.stringify(first) === JSON.stringify(second),
  bytes: new TextEncoder().encode(JSON.stringify(first)).byteLength,
  snapshot: first,
}));
""")
        self.assertIs(result["deterministic"], True)
        self.assertLessEqual(result["bytes"], 1024)
        self.assertEqual(result["snapshot"]["version"], 2)
        lowered = self.source.lower()
        for forbidden in (
            "node:http", "node:https", "fetch(", "axios", "curl ", "wget ",
            "process.env", "settimeout", "setinterval", "retry", "backoff",
            "runtime", "endpoint", "writefile", "appendfile",
        ):
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
