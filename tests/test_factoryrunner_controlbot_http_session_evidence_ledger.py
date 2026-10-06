import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "src" / "controlbot" / "http-session-evidence-ledger.ts"


class FactoryRunnerControlBotHttpSessionEvidenceLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = LEDGER.read_text(encoding="utf-8")

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

    def test_ledger_is_bounded_monotonic_and_fingerprinted(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const ledger = new HttpSessionEvidenceLedger();
const evidence = httpSessionEvidence(new HttpSessionClientError('transport_failed'));
for (let sequence = 1; sequence <= 64; sequence += 1) {
  ledger.append(sequence, evidence);
}
const snapshot = ledger.snapshot();
console.log(JSON.stringify({
  snapshot,
  frozen: Object.isFrozen(snapshot),
  entries_frozen: Object.isFrozen(snapshot.entries),
  all_entries_frozen: snapshot.entries.every((entry) => Object.isFrozen(entry)),
  all_evidence_frozen: snapshot.entries.every((entry) => Object.isFrozen(entry.evidence)),
}));
""")
        snapshot = result["snapshot"]
        self.assertEqual(snapshot["version"], 1)
        self.assertEqual(snapshot["capacity"], 64)
        self.assertEqual(snapshot["count"], 64)
        self.assertEqual(snapshot["first_sequence"], 1)
        self.assertEqual(snapshot["last_sequence"], 64)
        self.assertEqual([entry["sequence"] for entry in snapshot["entries"]], list(range(1, 65)))
        self.assertRegex(snapshot["ledger_fingerprint"], r"^[0-9a-f]{64}$")
        for entry in snapshot["entries"]:
            self.assertEqual(entry["version"], 1)
            self.assertRegex(entry["entry_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertIs(result["frozen"], True)
        self.assertIs(result["entries_frozen"], True)
        self.assertIs(result["all_entries_frozen"], True)
        self.assertIs(result["all_evidence_frozen"], True)

    def test_exact_duplicate_is_idempotent_without_growing_ledger(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const ledger = new HttpSessionEvidenceLedger();
const evidence = httpSessionEvidence(new HttpSessionClientError('client_disabled'));
const first = ledger.append(1, evidence);
const before = ledger.snapshot();
const duplicate = ledger.append(1, { ...evidence });
const after = ledger.snapshot();
console.log(JSON.stringify({
  same_entry: first === duplicate,
  before_count: before.count,
  after_count: after.count,
  same_fingerprint: before.ledger_fingerprint === after.ledger_fingerprint,
  entry_fingerprint: duplicate.entry_fingerprint,
}));
""")
        self.assertIs(result["same_entry"], True)
        self.assertEqual(result["before_count"], 1)
        self.assertEqual(result["after_count"], 1)
        self.assertIs(result["same_fingerprint"], True)
        self.assertRegex(result["entry_fingerprint"], r"^[0-9a-f]{64}$")

    def test_outcome_getter_is_read_once_and_cannot_change_after_validation(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';

const canonical = httpSessionEvidence(new HttpSessionClientError('client_disabled'));
const dynamic = { ...canonical };
let outcomeReads = 0;
Object.defineProperty(dynamic, 'outcome', {
  enumerable: true,
  configurable: true,
  get() {
    outcomeReads += 1;
    return outcomeReads === 1 ? 'client_disabled' : 'http_success';
  },
});

const ledger = new HttpSessionEvidenceLedger();
const entry = ledger.append(1, dynamic);
const snapshot = ledger.snapshot();
console.log(JSON.stringify({
  outcome_reads: outcomeReads,
  entry_outcome: entry.evidence.outcome,
  snapshot_outcome: snapshot.entries[0].evidence.outcome,
  evidence_fingerprint: entry.evidence.evidence_fingerprint,
  expected_fingerprint: canonical.evidence_fingerprint,
}));
""")
        self.assertEqual(result["outcome_reads"], 1)
        self.assertEqual(result["entry_outcome"], "client_disabled")
        self.assertEqual(result["snapshot_outcome"], "client_disabled")
        self.assertEqual(result["evidence_fingerprint"], result["expected_fingerprint"])

    def test_safety_getters_are_read_once_and_noncanonical_values_fail_closed(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';

const failed = (operation) => {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
};
const canonical = httpSessionEvidence(new HttpSessionClientError('transport_failed'));
const dynamic = { ...canonical };
const reads = {
  authority: 0,
  execution: 0,
  network_access: 0,
  external_mutation: 0,
};
const values = {
  authority: ['unchanged', 'expanded'],
  execution: [false, true],
  network_access: [false, true],
  external_mutation: [false, true],
};
for (const key of Object.keys(values)) {
  Object.defineProperty(dynamic, key, {
    enumerable: true,
    configurable: true,
    get() {
      reads[key] += 1;
      return values[key][reads[key] === 1 ? 0 : 1];
    },
  });
}

const ledger = new HttpSessionEvidenceLedger();
const entry = ledger.append(1, dynamic);

const noncanonical = { ...canonical };
let rejectedAuthorityReads = 0;
Object.defineProperty(noncanonical, 'authority', {
  enumerable: true,
  configurable: true,
  get() {
    rejectedAuthorityReads += 1;
    return 'expanded';
  },
});
const rejected = failed(() => new HttpSessionEvidenceLedger().append(1, noncanonical));

console.log(JSON.stringify({
  reads,
  entry_safety: {
    authority: entry.evidence.authority,
    execution: entry.evidence.execution,
    network_access: entry.evidence.network_access,
    external_mutation: entry.evidence.external_mutation,
  },
  rejected,
  rejected_authority_reads: rejectedAuthorityReads,
}));
""")
        self.assertEqual(
            result["reads"],
            {
                "authority": 1,
                "execution": 1,
                "network_access": 1,
                "external_mutation": 1,
            },
        )
        self.assertEqual(
            result["entry_safety"],
            {
                "authority": "unchanged",
                "execution": False,
                "network_access": False,
                "external_mutation": False,
            },
        )
        self.assertIs(result["rejected"], True)
        self.assertEqual(result["rejected_authority_reads"], 1)

    def test_sequence_drift_reorder_overflow_or_mixed_evidence_fails_closed(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const failed = (operation) => {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
};
const transport = httpSessionEvidence(new HttpSessionClientError('transport_failed'));
const disabled = httpSessionEvidence(new HttpSessionClientError('client_disabled'));

const startDrift = new HttpSessionEvidenceLedger();
const gapDrift = new HttpSessionEvidenceLedger();
gapDrift.append(1, transport);
const conflictingSequence = new HttpSessionEvidenceLedger();
conflictingSequence.append(1, transport);
const invalidEvidence = new HttpSessionEvidenceLedger();
const invalidFingerprint = new HttpSessionEvidenceLedger();
const overflow = new HttpSessionEvidenceLedger();
for (let sequence = 1; sequence <= 64; sequence += 1) overflow.append(sequence, transport);

console.log(JSON.stringify({
  start_drift: failed(() => startDrift.append(2, transport)),
  gap_drift: failed(() => gapDrift.append(3, transport)),
  conflicting_sequence: failed(() => conflictingSequence.append(1, disabled)),
  mixed_evidence: failed(() => invalidEvidence.append(1, { ...transport, body: { token: 'raw' } })),
  raw_input: failed(() => invalidEvidence.append(1, { body: { accepted: true } })),
  fingerprint_drift: failed(() => invalidFingerprint.append(1, {
    ...transport,
    evidence_fingerprint: '0'.repeat(64),
  })),
  overflow: failed(() => overflow.append(65, transport)),
  count_after_overflow: overflow.snapshot().count,
}));
""")
        self.assertEqual(
            result,
            {
                "start_drift": True,
                "gap_drift": True,
                "conflicting_sequence": True,
                "mixed_evidence": True,
                "raw_input": True,
                "fingerprint_drift": True,
                "overflow": True,
                "count_after_overflow": 64,
            },
        )

    def test_snapshot_is_secret_free_local_and_non_executing(self):
        result = self._node("""
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { stableSha256 } from './src/validation.ts';
const body = { accepted: true, private_payload: 'authorization=Bearer must-not-survive' };
const evidence = httpSessionEvidence({
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
});
const ledger = new HttpSessionEvidenceLedger();
ledger.append(1, evidence);
const first = ledger.snapshot();
const second = ledger.snapshot();
console.log(JSON.stringify({
  first,
  deterministic: JSON.stringify(first) === JSON.stringify(second),
  bytes: new TextEncoder().encode(JSON.stringify(first)).byteLength,
  frozen: Object.isFrozen(first) && Object.isFrozen(first.entries),
}));
""")
        snapshot = result["first"]
        serialized = json.dumps(snapshot).lower()
        self.assertIs(result["deterministic"], True)
        self.assertIs(result["frozen"], True)
        self.assertLessEqual(result["bytes"], 128 * 1024)
        self.assertEqual(snapshot["authority"], "unchanged")
        self.assertIs(snapshot["execution"], False)
        self.assertIs(snapshot["network_access"], False)
        self.assertIs(snapshot["external_mutation"], False)
        for forbidden in (
            "private_payload", "must-not-survive", "authorization", "bearer",
            "cookie", "password", "secret", "token", "body",
        ):
            self.assertNotIn(forbidden, serialized)

        lowered = self.source.lower()
        for forbidden in (
            "node:http", "node:https", "fetch(", "axios", "curl ", "wget ",
            "process.env", "writefile", "appendfile", "readfile", "settimeout(",
        ):
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
