import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIAGNOSTIC = ROOT / "src" / "controlbot" / "http-session-diagnostic.ts"


class FactoryRunnerControlBotHttpSessionDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = DIAGNOSTIC.read_text(encoding="utf-8")

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

    def test_prepared_requires_coherent_disabled_or_test_only_status_compatible_public_contract_and_safe_ledger(self):
        result = self._node("""
import { ControlBotHttpSessionClient, HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { httpSessionDiagnostic } from './src/controlbot/http-session-diagnostic.ts';
import { controlBotHttpPublicManifest } from './src/controlbot-http-public-manifest.ts';
import { controlBotHttpPublicCompatibility } from './src/controlbot-http-public-compatibility.ts';
import { stableSha256 } from './src/validation.ts';

const manifest = controlBotHttpPublicManifest();
const requirements = {
  version: manifest.version,
  subpath: manifest.subpath,
  protocol_version: manifest.protocol_version,
  fencing: manifest.fencing,
  session_transport: manifest.session_transport,
  authority: manifest.authority,
  execution: manifest.execution,
  network_access: manifest.network_access,
  external_mutation: manifest.external_mutation,
  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({
    export_name, contract_version, capability,
  })),
};
const compatibility = controlBotHttpPublicCompatibility(manifest, requirements);

const disabledStatus = new ControlBotHttpSessionClient().status();
const disabledLedger = new HttpSessionEvidenceLedger();
disabledLedger.append(1, httpSessionEvidence(new HttpSessionClientError('client_disabled')));
const disabled = httpSessionDiagnostic(disabledStatus, compatibility, disabledLedger.snapshot());

const testOnlyStatus = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  test_transport: async () => { throw new Error('must-not-run'); },
}).status();
const body = { accepted: true };
const success = httpSessionEvidence({
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
const testOnlyLedger = new HttpSessionEvidenceLedger();
testOnlyLedger.append(1, success);
const testOnly = httpSessionDiagnostic(testOnlyStatus, compatibility, testOnlyLedger.snapshot());

console.log(JSON.stringify({
  disabled,
  test_only: testOnly,
  disabled_frozen: Object.isFrozen(disabled) && Object.isFrozen(disabled.reasons),
  test_only_frozen: Object.isFrozen(testOnly) && Object.isFrozen(testOnly.reasons),
}));
""")
        for key in ("disabled", "test_only"):
            diagnostic = result[key]
            self.assertEqual(diagnostic["version"], 1)
            self.assertEqual(diagnostic["status"], "PREPARED")
            self.assertEqual(diagnostic["reasons"], [])
            self.assertEqual(diagnostic["evidence_count"], 1)
            self.assertRegex(diagnostic["status_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertRegex(diagnostic["compatibility_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertRegex(diagnostic["ledger_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertRegex(diagnostic["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertIs(result["disabled_frozen"], True)
        self.assertIs(result["test_only_frozen"], True)

    def test_incompatible_mixed_unknown_or_drifted_inputs_block_fail_closed(self):
        result = self._node("""
import { ControlBotHttpSessionClient, HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { httpSessionDiagnostic } from './src/controlbot/http-session-diagnostic.ts';
import { controlBotHttpPublicManifest } from './src/controlbot-http-public-manifest.ts';
import { controlBotHttpPublicCompatibility } from './src/controlbot-http-public-compatibility.ts';
import { stableSha256 } from './src/validation.ts';

const manifest = controlBotHttpPublicManifest();
const requirements = {
  version: manifest.version,
  subpath: manifest.subpath,
  protocol_version: manifest.protocol_version,
  fencing: manifest.fencing,
  session_transport: manifest.session_transport,
  authority: manifest.authority,
  execution: manifest.execution,
  network_access: manifest.network_access,
  external_mutation: manifest.external_mutation,
  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({
    export_name, contract_version, capability,
  })),
};
const compatible = controlBotHttpPublicCompatibility(manifest, requirements);
const incompatible = controlBotHttpPublicCompatibility(manifest, {
  ...requirements,
  session_transport: 'live-network',
});
const disabledStatus = new ControlBotHttpSessionClient().status();
const enabledStatus = new ControlBotHttpSessionClient({
  enabled: true,
  test_mode: true,
  test_transport: async () => { throw new Error('must-not-run'); },
}).status();
const disabledEvidence = httpSessionEvidence(new HttpSessionClientError('client_disabled'));
const disabledLedger = new HttpSessionEvidenceLedger();
disabledLedger.append(1, disabledEvidence);
const body = { accepted: true };
const success = httpSessionEvidence({
  version: 1,
  path: '/v1/runner/heartbeat',
  status: 200,
  request_fingerprint: 'b'.repeat(64),
  response_fingerprint: stableSha256(body),
  body,
  transport_mode: 'injected_test_only',
  authority: 'unchanged',
  execution: false,
  network_access: false,
  external_mutation: false,
});
const successLedger = new HttpSessionEvidenceLedger();
successLedger.append(1, success);
const driftedLedger = { ...disabledLedger.snapshot(), ledger_fingerprint: '0'.repeat(64) };

const reports = {
  incompatible: httpSessionDiagnostic(disabledStatus, incompatible, disabledLedger.snapshot()),
  unknown: httpSessionDiagnostic({ ...disabledStatus, unknown_field: true }, compatible, disabledLedger.snapshot()),
  stale: httpSessionDiagnostic(enabledStatus, compatible, disabledLedger.snapshot()),
  mixed: httpSessionDiagnostic(disabledStatus, compatible, successLedger.snapshot()),
  drifted: httpSessionDiagnostic(disabledStatus, compatible, driftedLedger),
  empty: httpSessionDiagnostic(disabledStatus, compatible, new HttpSessionEvidenceLedger().snapshot()),
};
console.log(JSON.stringify(reports));
""")
        for diagnostic in result.values():
            self.assertEqual(diagnostic["status"], "BLOCKED")
            self.assertGreaterEqual(len(diagnostic["reasons"]), 1)
            self.assertEqual(diagnostic["authority"], "unchanged")
            self.assertIs(diagnostic["execution"], False)
            self.assertIs(diagnostic["network_access"], False)
            self.assertIs(diagnostic["external_mutation"], False)
        self.assertIn("COMPATIBILITY_INCOMPATIBLE", result["incompatible"]["reasons"])
        self.assertIn("STATUS_INVALID", result["unknown"]["reasons"])
        self.assertIn("LEDGER_STATUS_MISMATCH", result["stale"]["reasons"])
        self.assertIn("EVIDENCE_NOT_PREPARED", result["stale"]["reasons"])
        self.assertIn("LEDGER_STATUS_MISMATCH", result["mixed"]["reasons"])
        self.assertIn("LEDGER_INVALID", result["drifted"]["reasons"])
        self.assertIn("LEDGER_EMPTY", result["empty"]["reasons"])

    def test_diagnostic_never_reports_live_ready_or_expanded_authority(self):
        result = self._node("""
import { ControlBotHttpSessionClient, HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { httpSessionDiagnostic } from './src/controlbot/http-session-diagnostic.ts';
import { controlBotHttpPublicManifest } from './src/controlbot-http-public-manifest.ts';
import { controlBotHttpPublicCompatibility } from './src/controlbot-http-public-compatibility.ts';

const manifest = controlBotHttpPublicManifest();
const requirements = {
  version: manifest.version,
  subpath: manifest.subpath,
  protocol_version: manifest.protocol_version,
  fencing: manifest.fencing,
  session_transport: manifest.session_transport,
  authority: manifest.authority,
  execution: manifest.execution,
  network_access: manifest.network_access,
  external_mutation: manifest.external_mutation,
  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({
    export_name, contract_version, capability,
  })),
};
const compatibility = controlBotHttpPublicCompatibility(manifest, requirements);
const status = new ControlBotHttpSessionClient().status();
const ledger = new HttpSessionEvidenceLedger();
ledger.append(1, httpSessionEvidence(new HttpSessionClientError('client_disabled')));
const prepared = httpSessionDiagnostic(status, compatibility, ledger.snapshot());
const blocked = httpSessionDiagnostic({ ...status, authority: 'expanded' }, compatibility, ledger.snapshot());
console.log(JSON.stringify({ prepared, blocked }));
""")
        for diagnostic in result.values():
            serialized = json.dumps(diagnostic)
            self.assertNotIn('"LIVE"', serialized)
            self.assertNotIn('"READY"', serialized)
            self.assertIn(diagnostic["status"], ("PREPARED", "BLOCKED"))
            self.assertEqual(diagnostic["authority"], "unchanged")
            self.assertIs(diagnostic["execution"], False)
            self.assertIs(diagnostic["network_access"], False)
            self.assertIs(diagnostic["external_mutation"], False)
        self.assertEqual(result["blocked"]["status"], "BLOCKED")
        self.assertIn("STATUS_INVALID", result["blocked"]["reasons"])

    def test_diagnostic_is_deterministic_bounded_secret_free_and_non_executing(self):
        result = self._node("""
import { ControlBotHttpSessionClient, HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { httpSessionDiagnostic } from './src/controlbot/http-session-diagnostic.ts';
import { controlBotHttpPublicManifest } from './src/controlbot-http-public-manifest.ts';
import { controlBotHttpPublicCompatibility } from './src/controlbot-http-public-compatibility.ts';

const manifest = controlBotHttpPublicManifest();
const requirements = {
  version: manifest.version,
  subpath: manifest.subpath,
  protocol_version: manifest.protocol_version,
  fencing: manifest.fencing,
  session_transport: manifest.session_transport,
  authority: manifest.authority,
  execution: manifest.execution,
  network_access: manifest.network_access,
  external_mutation: manifest.external_mutation,
  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({
    export_name, contract_version, capability,
  })),
};
const compatibility = controlBotHttpPublicCompatibility(manifest, requirements);
const status = new ControlBotHttpSessionClient().status();
const ledger = new HttpSessionEvidenceLedger();
ledger.append(1, httpSessionEvidence(new HttpSessionClientError('client_disabled')));
const poisoned = {
  ...status,
  body: { authorization: 'Bearer must-not-survive', token: 'secret-value' },
};
const first = httpSessionDiagnostic(poisoned, compatibility, ledger.snapshot());
const second = httpSessionDiagnostic(poisoned, compatibility, ledger.snapshot());
console.log(JSON.stringify({
  first,
  deterministic: JSON.stringify(first) === JSON.stringify(second),
  bytes: new TextEncoder().encode(JSON.stringify(first)).byteLength,
  frozen: Object.isFrozen(first) && Object.isFrozen(first.reasons),
}));
""")
        diagnostic = result["first"]
        serialized = json.dumps(diagnostic).lower()
        self.assertIs(result["deterministic"], True)
        self.assertIs(result["frozen"], True)
        self.assertLessEqual(result["bytes"], 4 * 1024)
        self.assertEqual(diagnostic["status"], "BLOCKED")
        self.assertIn("STATUS_INVALID", diagnostic["reasons"])
        for forbidden in (
            "must-not-survive", "authorization", "bearer", "secret-value",
            "cookie", "password", "token", "body", "payload", "endpoint",
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
