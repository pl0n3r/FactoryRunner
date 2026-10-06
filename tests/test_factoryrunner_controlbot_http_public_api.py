import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "src" / "controlbot-http-public.ts"
PACKAGE = ROOT / "package.json"
BUILDER = ROOT / "scripts" / "build-observability-package.ts"


def observe() -> dict[str, object]:
    script = r"""
import * as publicApi from './src/controlbot-http-public.ts';
import {
  controlBotRunnerHttpRequest as internalProtocol,
} from './src/controlbot/http-protocol-v1.ts';
import {
  assertFencedAck as internalAssertAck,
  assertFencedEvent as internalAssertEvent,
  bindFencedExecution as internalBind,
} from './src/controlbot/fenced-execution-binding.ts';
import {
  ControlBotHttpSessionClient as InternalClient,
  HttpSessionClientError as InternalError,
} from './src/controlbot/http-session-client.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const poll = publicApi.controlBotRunnerHttpRequest({
  version: 1,
  method: 'POST',
  path: '/v1/runner/poll',
  payload: {
    version: 1,
    runner_id: runnerId,
    session_id: 'factoryrunner:session:422',
    generation: 7,
    requested_at: 1000,
  },
});

const client = new publicApi.ControlBotHttpSessionClient();
const status = client.status();

let enableWithoutTestRejected = false;
let transportWithoutEnableRejected = false;
try {
  new publicApi.ControlBotHttpSessionClient({ enabled: true });
} catch {
  enableWithoutTestRejected = true;
}
try {
  new publicApi.ControlBotHttpSessionClient({
    test_transport: async () => ({
      version: 1,
      request_fingerprint: 'a'.repeat(64),
      status: 200,
      body: {},
    }),
  });
} catch {
  transportWithoutEnableRejected = true;
}

console.log(JSON.stringify({
  exports: Object.keys(publicApi).sort(),
  identity: {
    protocol: publicApi.controlBotRunnerHttpRequest === internalProtocol,
    bind: publicApi.bindFencedExecution === internalBind,
    ack: publicApi.assertFencedAck === internalAssertAck,
    event: publicApi.assertFencedEvent === internalAssertEvent,
    client: publicApi.ControlBotHttpSessionClient === InternalClient,
    error: publicApi.HttpSessionClientError === InternalError,
  },
  poll,
  status,
  enable_without_test_rejected: enableWithoutTestRejected,
  transport_without_enable_rejected: transportWithoutEnableRejected,
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerControlBotHttpPublicApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.source = ENTRYPOINT.read_text(encoding="utf-8")
        cls.manifest = json.loads(PACKAGE.read_text(encoding="utf-8"))
        cls.builder = BUILDER.read_text(encoding="utf-8")

    def test_public_subpath_exports_only_protocol_binding_and_session_client_surface(self):
        self.assertEqual(
            self.observed["exports"],
            [
                "CONTROLBOT_HTTP_PUBLIC_EXPORTS",
                "ControlBotHttpSessionClient",
                "HttpSessionClientError",
                "assertFencedAck",
                "assertFencedEvent",
                "bindFencedExecution",
                "controlBotHttpPublicCompatibility",
                "controlBotHttpPublicManifest",
                "controlBotRunnerHttpRequest",
            ],
        )
        self.assertTrue(all(self.observed["identity"].values()))

        for symbol in (
            "ControlBotRunnerHttpContractResult",
            "ControlBotRunnerHttpEnvelope",
            "ControlBotRunnerHttpPath",
            "ControlBotExecutionOrderV1",
            "FencedExecutionBinding",
            "FencedExecutionOutcome",
            "FencedExecutionSessionV1",
            "HttpSessionClientOptions",
            "HttpSessionClientResult",
            "HttpSessionClientStatus",
            "HttpSessionTransportRequest",
            "HttpSessionTransportResponse",
            "InjectedHttpSessionTransport",
        ):
            self.assertIn(f"type {symbol}", self.source)

    def test_package_declares_controlbot_http_subpath_and_required_files_only(self):
        self.assertEqual(
            self.manifest["exports"]["./controlbot-http"],
            "./src/controlbot-http-public.ts",
        )

        for path in (
            "src/controlbot-http-public.ts",
            "src/controlbot/fenced-execution-binding.ts",
            "src/controlbot/http-protocol-v1.ts",
            "src/controlbot/http-session-client.ts",
            "src/order.ts",
            "src/validation.ts",
        ):
            self.assertIn(path, self.manifest["files"])

        for unrelated_internal in (
            "src/controlbot/client.ts",
            "src/controlbot/connection-profile.ts",
            "src/controlbot/https-transport.ts",
        ):
            self.assertNotIn(unrelated_internal, self.manifest["files"])

        self.assertEqual(self.manifest["files"], sorted(set(self.manifest["files"])))
        self.assertIn(
            "'./controlbot-http': 'src/controlbot-http-public.ts'",
            self.builder,
        )

    def test_public_surface_preserves_fail_closed_authority_and_disabled_network_defaults(self):
        poll = self.observed["poll"]
        self.assertEqual(poll["authority"], "unchanged")
        self.assertFalse(poll["execution"])
        self.assertFalse(poll["network_access"])
        self.assertFalse(poll["external_mutation"])
        self.assertEqual(poll["path"], "/v1/runner/poll")
        self.assertEqual(poll["payload"]["generation"], 7)

        status = self.observed["status"]
        self.assertFalse(status["enabled"])
        self.assertEqual(status["transport_mode"], "disabled")
        self.assertEqual(status["authority"], "unchanged")
        self.assertFalse(status["execution"])
        self.assertFalse(status["network_access"])
        self.assertFalse(status["external_mutation"])

        self.assertTrue(self.observed["enable_without_test_rejected"])
        self.assertTrue(self.observed["transport_without_enable_rejected"])

    def test_wrapper_has_no_runtime_wiring_endpoint_credentials_or_wildcard_exports(self):
        self.assertNotIn("export *", self.source)
        for forbidden in (
            "RuntimeSupervisor",
            "ControlBotClient",
            "process.env",
            "Authorization",
            "Bearer ",
            "fetch(",
            "node:http",
            "node:https",
            "node:net",
            "node:child_process",
            "endpoint",
            "base_url",
            "token",
            "secret",
            "password",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
