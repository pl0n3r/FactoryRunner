"""Offline V3 contract: immutable HTTP response snapshots and fingerprints."""
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SCRIPT = r"""
import { ControlBotHttpSessionClient } from './src/controlbot/http-session-client.ts';
import { stableSha256 } from './src/validation.ts';
const poll = {
  version: 1, runner_id: '11111111-1111-7111-8111-111111111111',
  session_id: 'session_001', generation: 7, requested_at: 1000,
};
const source = { nested: { values: [{ count: 7 }, { count: 8 }] }, flags: [true, false] };
function makeClient(body, overrides = {}) {
  return new ControlBotHttpSessionClient({
    enabled: true, test_mode: true, timeout_ms: 100, max_response_bytes: 512,
    test_transport: async (request) => ({
      version: overrides.version ?? 1,
      request_fingerprint: overrides.fingerprint ?? request.request_fingerprint,
      status: overrides.status ?? 200, body,
    }),
  });
}
const client = makeClient(source);
const result = await client.poll(poll);
const frozen = [
  result.body, result.body.nested, result.body.nested.values,
  result.body.nested.values[0], result.body.flags,
].every(Object.isFrozen);
const serialized = JSON.stringify(result.body);
const fingerprint = stableSha256(result.body);
let nestedDenied = false, arrayDenied = false;
try { result.body.nested.values[0].count = 99; } catch { nestedDenied = true; }
try { result.body.flags.push(false); } catch { arrayDenied = true; }
source.nested.values[0].count = 100;
source.nested.values.push({ count: 200 });
source.flags[0] = false;
const isolated = (
  result.body !== source && result.body.nested !== source.nested
  && result.body.nested.values !== source.nested.values
  && result.body.nested.values[0].count === 7
  && result.body.nested.values.length === 2
  && result.body.flags[0] === true
  && JSON.stringify(result.body) === serialized
  && stableSha256(result.body) === fingerprint
  && result.response_fingerprint === fingerprint
);
async function rejects(body, opts = {}) {
  try { await makeClient(body, opts).poll(poll); return false; }
  catch { return true; }
}
const cyclic = {}; cyclic.self = cyclic;
const customSerializer = { nested: { toJSON() { return { hidden: 'modified' }; } } };
const getterBody = { nested: {} };
Object.defineProperty(getterBody.nested, 'danger', {
  get() { throw new Error('must never invoke accessor'); }, enumerable: true,
});
const hiddenBody = { nested: {} };
Object.defineProperty(hiddenBody.nested, 'secret', { value: true, enumerable: false });
const sparse = []; sparse.length = 2; sparse[1] = 4;
const negatives = [
  await rejects([]), await rejects(null),
  await rejects({ data: 'x'.repeat(3000) }), await rejects(cyclic),
  await rejects({ ok: true }, { version: 2 }),
  await rejects({ ok: true }, { status: 500 }),
  await rejects({ ok: true }, { fingerprint: 'f'.repeat(64) }),
  await rejects({ nested: { missing: undefined } }),
  await rejects({ nested: { missing: () => 1 } }),
  await rejects({ nested: { missing: Symbol('ignored') } }),
  await rejects({ nested: { count: Number.NaN } }),
  await rejects({ nested: { count: Number.POSITIVE_INFINITY } }),
  await rejects({ nested: { count: Number.NEGATIVE_INFINITY } }),
  await rejects({ nested: { count: -0 } }),
  await rejects({ nested: { value: new Date(0) } }),
  await rejects(customSerializer),
  await rejects(getterBody),
  await rejects(hiddenBody),
  await rejects({ nested: sparse }),
];
const signal = new AbortController(); signal.abort();
let abortCode = null;
try { await client.poll(poll, { signal: signal.signal }); }
catch (error) { abortCode = error?.code ?? null; }
console.log(JSON.stringify({
  frozen, nestedDenied, arrayDenied, isolated, negatives, abortCode,
  version: result.version, transport_mode: result.transport_mode,
  authority: result.authority, execution: result.execution,
  network_access: result.network_access, external_mutation: result.external_mutation,
}));
"""


class FactoryRunnerHttpResponseSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", SCRIPT],
            cwd=ROOT, text=True, capture_output=True, timeout=25, check=False,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"Node fixture failed with {result.returncode}: {result.stderr[-1200:]}"
            )
        cls.report = json.loads(result.stdout.strip().splitlines()[-1])

    def test_nested_body_is_immutable(self):
        self.assertTrue(self.report["frozen"])
        self.assertTrue(self.report["nestedDenied"])
        self.assertTrue(self.report["arrayDenied"])

    def test_transport_source_mutation_isolated(self):
        self.assertTrue(self.report["isolated"])

    def test_invalid_and_legacy_contracts(self):
        self.assertTrue(all(self.report["negatives"]))
        self.assertEqual(self.report["abortCode"], "transport_aborted")
        self.assertEqual(self.report["version"], 1)
        self.assertEqual(self.report["transport_mode"], "injected_test_only")
        self.assertEqual(self.report["authority"], "unchanged")
        self.assertIs(self.report["execution"], False)
        self.assertIs(self.report["network_access"], False)
        self.assertIs(self.report["external_mutation"], False)


if __name__ == "__main__":
    unittest.main()
