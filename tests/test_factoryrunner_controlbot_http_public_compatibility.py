import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = (ROOT / "src/controlbot-http-public.ts").read_text(encoding="utf-8")
MANIFEST_SOURCE = (ROOT / "src/controlbot-http-public-manifest.ts").read_text(encoding="utf-8")
COMPAT_SOURCE = (ROOT / "src/controlbot-http-public-compatibility.ts").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

EXPECTED_EXPORTS = [
    ("controlBotRunnerHttpRequest", "protocol"),
    ("assertFencedAck", "fencing"),
    ("assertFencedEvent", "fencing"),
    ("bindFencedExecution", "fencing"),
    ("ControlBotHttpSessionClient", "session"),
    ("HttpSessionClientError", "session"),
]


def observe() -> dict[str, object]:
    script = r"""
const publicApi = await import('./src/controlbot-http-public.ts');
const manifest = publicApi.controlBotHttpPublicManifest();
const requirements = {
  version: 1,
  subpath: './controlbot-http',
  protocol_version: 1,
  fencing: 'required',
  session_transport: 'injected_test_only',
  authority: 'unchanged',
  execution: false,
  network_access: false,
  external_mutation: false,
  required_exports: manifest.exports.map(({ export_name, contract_version, capability }) => ({
    export_name,
    contract_version,
    capability,
  })),
};
const check = (candidateManifest, candidateRequirements) =>
  publicApi.controlBotHttpPublicCompatibility(candidateManifest, candidateRequirements);

const invalid = {
  unknown: check(manifest, {
    ...requirements,
    required_exports: [
      ...requirements.required_exports,
      { export_name: 'unknownControlBotHttpExport', contract_version: 1, capability: 'protocol' },
    ],
  }),
  missing: check(manifest, {
    ...requirements,
    required_exports: requirements.required_exports.slice(0, -1),
  }),
  mixed: check(manifest, {
    ...requirements,
    required_exports: requirements.required_exports.map((entry, index) =>
      index === 0 ? { ...entry, capability: 'session' } : entry),
  }),
  stale: check(manifest, { ...requirements, version: 2 }),
  protocol: check(manifest, { ...requirements, protocol_version: 2 }),
  fencing: check(manifest, { ...requirements, fencing: 'optional' }),
  session: check(manifest, { ...requirements, session_transport: 'network' }),
  authority: check(manifest, { ...requirements, authority: 'expanded' }),
  execution: check(manifest, { ...requirements, execution: true }),
  requirement_shape: check(manifest, { ...requirements, unexpected: true }),
  manifest_tampered: check({ ...manifest, fingerprint: '0'.repeat(64) }, requirements),
  manifest_mixed: check({
    ...manifest,
    exports: [
      ...manifest.exports,
      { export_name: 'unknownControlBotHttpExport', contract_version: 1, capability: 'protocol' },
    ],
  }, requirements),
};
const exact = check(manifest, requirements);
console.log(JSON.stringify({
  manifest,
  requirements,
  exact,
  exactAgain: check(manifest, requirements),
  invalid,
  runtimeExports: Object.keys(publicApi).filter((name) => [
    'controlBotRunnerHttpRequest',
    'assertFencedAck',
    'assertFencedEvent',
    'bindFencedExecution',
    'ControlBotHttpSessionClient',
    'HttpSessionClientError',
    'controlBotHttpPublicManifest',
    'controlBotHttpPublicCompatibility',
  ].includes(name)).sort(),
  frozen: {
    manifest: Object.isFrozen(manifest),
    exports: Object.isFrozen(manifest.exports),
    exact: Object.isFrozen(exact),
    reasons: Object.isFrozen(exact.reasons),
  },
}));
"""
    raw = subprocess.check_output(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerControlBotHttpPublicCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def assert_safe(self, value: dict[str, object]) -> None:
        self.assertEqual(value["authority"], "unchanged")
        self.assertFalse(value["execution"])
        self.assertFalse(value["network_access"])
        self.assertFalse(value["external_mutation"])

    def test_manifest_is_closed_versioned_and_matches_public_subpath(self):
        manifest = self.observed["manifest"]
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["subpath"], "./controlbot-http")
        self.assertEqual(manifest["protocol_version"], 1)
        self.assertEqual(manifest["fencing"], "required")
        self.assertEqual(manifest["session_transport"], "injected_test_only")
        self.assertEqual(
            [(entry["export_name"], entry["capability"]) for entry in manifest["exports"]],
            EXPECTED_EXPORTS,
        )
        self.assertEqual({entry["contract_version"] for entry in manifest["exports"]}, {1})
        self.assertRegex(manifest["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertTrue(self.observed["frozen"]["manifest"])
        self.assertTrue(self.observed["frozen"]["exports"])
        self.assert_safe(manifest)

        self.assertIn("controlBotHttpPublicManifest", PUBLIC)
        self.assertIn("controlBotHttpPublicCompatibility", PUBLIC)
        self.assertEqual(PACKAGE["exports"]["./controlbot-http"], "./src/controlbot-http-public.ts")
        self.assertIn("src/controlbot-http-public-manifest.ts", PACKAGE["files"])
        self.assertIn("src/controlbot-http-public-compatibility.ts", PACKAGE["files"])

    def test_compatible_requirements_accept_exact_protocol_fencing_and_session_surface(self):
        exact = self.observed["exact"]
        self.assertEqual(exact, self.observed["exactAgain"])
        self.assertEqual(exact["status"], "COMPATIBLE")
        self.assertEqual(exact["reasons"], [])
        self.assertEqual(exact["manifest_fingerprint"], self.observed["manifest"]["fingerprint"])
        self.assertTrue(self.observed["frozen"]["exact"])
        self.assertTrue(self.observed["frozen"]["reasons"])
        self.assert_safe(exact)
        self.assertEqual(
            self.observed["runtimeExports"],
            sorted([
                "controlBotRunnerHttpRequest",
                "assertFencedAck",
                "assertFencedEvent",
                "bindFencedExecution",
                "ControlBotHttpSessionClient",
                "HttpSessionClientError",
                "controlBotHttpPublicManifest",
                "controlBotHttpPublicCompatibility",
            ]),
        )

    def test_unknown_missing_mixed_or_authority_expanding_requirements_fail_closed(self):
        expected = {
            "unknown": ["CONTRACT_MISSING"],
            "missing": ["CONTRACT_MISSING"],
            "mixed": ["SURFACE_MISMATCH"],
            "stale": ["VERSION_MISMATCH"],
            "protocol": ["PROTOCOL_MISMATCH"],
            "fencing": ["FENCING_MISMATCH"],
            "session": ["SESSION_MISMATCH"],
            "authority": ["SAFETY_MISMATCH"],
            "execution": ["SAFETY_MISMATCH"],
            "requirement_shape": ["REQUIREMENTS_INVALID"],
            "manifest_tampered": ["MANIFEST_INVALID"],
            "manifest_mixed": ["MANIFEST_INVALID"],
        }
        for name, reasons in expected.items():
            with self.subTest(name=name):
                result = self.observed["invalid"][name]
                self.assertEqual(result["status"], "INCOMPATIBLE")
                self.assertEqual(result["reasons"], reasons)
                self.assert_safe(result)

    def test_compatibility_is_local_deterministic_and_non_executing(self):
        self.assertEqual(self.observed["exact"], self.observed["exactAgain"])
        source = MANIFEST_SOURCE + "\n" + COMPAT_SOURCE
        for forbidden in (
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
            "fetch(",
            "process.",
            "Deno.",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)

        serialized = json.dumps(self.observed, sort_keys=True).lower()
        for forbidden in ("password", "cookie", "authorization", "bearer ", "dsn"):
            self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
