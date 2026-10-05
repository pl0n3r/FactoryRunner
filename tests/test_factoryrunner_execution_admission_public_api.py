import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "src" / "execution-admission-public.ts"
PACKAGE = ROOT / "package.json"


def observe() -> dict[str, object]:
    script = r"""
import * as publicApi from './src/execution-admission-public.ts';
import { executionAdmissionDecision as internalDecision } from './src/execution-admission.ts';
import { admissionEvidence as internalEvidence } from './src/admission-evidence.ts';
import { capabilityManifest } from './src/capability-manifest.ts';
import { resourceSnapshot } from './src/resource-snapshot.ts';
import { parseRunnerIdentity } from './src/runner.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const now = 1200;
const identity = parseRunnerIdentity({
  version: 1,
  runner_id: runnerId,
  protocol_version: 1,
  runtime: 'node',
  runtime_version: '0.1.0',
  platform: 'linux-arm64',
  location: 'test',
  capabilities: ['git.head'],
  max_parallel: 1,
});
const manifest = capabilityManifest(identity, [{
  id: 'git-adapter',
  capabilities: ['git.head'],
}]);
const order = {
  version: 1,
  order_id: '22222222-2222-7222-8222-222222222222',
  work_item_id: 'factoryrunner:work:403',
  runner_id: runnerId,
  capability: 'git.head',
  attempt: 1,
  issued_at: 1100,
  expires_at: 1300,
  instruction_ref: 'controlbot:instruction:factoryrunner-403',
};
function resource(active = 0, status = 'ready') {
  return resourceSnapshot(
    identity,
    {
      version: 1,
      runner_id: runnerId,
      sequence: 7,
      observed_at: 1190,
      status,
      capacity: { max: 1, active },
      active_sessions: active === 0 ? [] : ['factoryrunner:session:busy'],
    },
    { version: 1, runner_id: runnerId, observed_at: 1190, queued_orders: 1 },
    now,
    30,
  );
}

const allow = publicApi.executionAdmissionDecision(identity, order, manifest, resource(), now);
const wait = publicApi.executionAdmissionDecision(identity, order, manifest, resource(1, 'busy'), now);
const blocked = publicApi.executionAdmissionDecision(identity, order, manifest, resource(0, 'draining'), now);
const evidence = publicApi.admissionEvidence(allow);

let extraRejected = false;
let authorityRejected = false;
try { publicApi.admissionEvidence({ ...allow, raw_payload: { token: 'secret' } }); } catch { extraRejected = true; }
try { publicApi.admissionEvidence({ ...allow, authority: 'expanded' }); } catch { authorityRejected = true; }

console.log(JSON.stringify({
  exports: Object.keys(publicApi).sort(),
  same_decision: publicApi.executionAdmissionDecision === internalDecision,
  same_evidence: publicApi.admissionEvidence === internalEvidence,
  allow,
  wait,
  blocked,
  evidence,
  extra_rejected: extraRejected,
  authority_rejected: authorityRejected,
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerExecutionAdmissionPublicApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.source = ENTRYPOINT.read_text(encoding="utf-8")
        cls.manifest = json.loads(PACKAGE.read_text(encoding="utf-8"))

    def test_public_subpath_exports_admission_decision_and_evidence_without_expanding_authority(self):
        self.assertEqual(
            self.observed["exports"],
            ["admissionEvidence", "executionAdmissionDecision"],
        )
        for symbol in (
            "ExecutionAdmissionDecision",
            "ExecutionAdmissionState",
            "AdmissionEvidence",
        ):
            self.assertIn(f"type {symbol}", self.source)
        self.assertTrue(self.observed["same_decision"])
        self.assertTrue(self.observed["same_evidence"])

    def test_package_boundary_declares_execution_admission_subpath_and_required_files(self):
        self.assertEqual(
            self.manifest["exports"]["./execution-admission"],
            "./src/execution-admission-public.ts",
        )
        for path in (
            "src/execution-admission-public.ts",
            "src/execution-admission.ts",
            "src/admission-evidence.ts",
            "src/capability-manifest.ts",
            "src/order.ts",
            "src/runner.ts",
            "src/validation.ts",
        ):
            self.assertIn(path, self.manifest["files"])
        self.assertEqual(self.manifest["files"], sorted(set(self.manifest["files"])))

    def test_public_contract_remains_secret_free_and_authority_unchanged(self):
        for key in ("allow", "wait", "blocked", "evidence"):
            value = self.observed[key]
            self.assertEqual(value["authority"], "unchanged")
            serialized = json.dumps(value, sort_keys=True)
            for forbidden in (
                "instruction_ref",
                "controlbot:instruction",
                "payload",
                "adapters",
                "capabilities",
                "secret",
                "token",
            ):
                self.assertNotIn(forbidden, serialized)
        self.assertEqual(self.observed["allow"]["decision"], "ALLOW")
        self.assertEqual(self.observed["wait"]["decision"], "WAIT_CAPACITY")
        self.assertEqual(self.observed["blocked"]["decision"], "BLOCKED")

    def test_public_wrapper_reuses_fail_closed_internal_validation(self):
        self.assertTrue(self.observed["same_decision"])
        self.assertTrue(self.observed["same_evidence"])
        self.assertTrue(self.observed["extra_rejected"])
        self.assertTrue(self.observed["authority_rejected"])
        self.assertNotIn("export *", self.source)
        for forbidden in (
            "node:fs",
            "node:net",
            "node:http",
            "node:https",
            "node:child_process",
            "Adapter",
            "capabilityManifest",
            "instruction_ref",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
