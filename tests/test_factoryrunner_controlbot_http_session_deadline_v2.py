import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "http-session-client.ts"

POLL_PAYLOAD = """
{
  version: 1,
  runner_id: '123e4567-e89b-12d3-a456-426614174000',
  session_id: 'session-1',
  generation: 1,
  requested_at: 1,
}
"""


class FactoryRunnerControlBotHttpSessionDeadlineV2Tests(unittest.TestCase):
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

    def test_v1_calls_and_one_argument_transports_remain_compatible_without_abort_signal(self):
        result = self._node(f"""
import {{ ControlBotHttpSessionClient }} from './src/controlbot/http-session-client.ts';
let calls = 0;
async function legacyTransport(request) {{
  calls += 1;
  return {{
    version: 1,
    request_fingerprint: request.request_fingerprint,
    status: 200,
    body: {{ ok: true }},
  }};
}}
const client = new ControlBotHttpSessionClient({{
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  test_transport: legacyTransport,
}});
const value = await client.poll({POLL_PAYLOAD});
console.log(JSON.stringify({{
  calls,
  formal_args: legacyTransport.length,
  status: value.status,
  transport_mode: value.transport_mode,
  authority: value.authority,
  execution: value.execution,
  network_access: value.network_access,
  external_mutation: value.external_mutation,
}}));
""")
        self.assertEqual(result["calls"], 1)
        self.assertEqual(result["formal_args"], 1)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["transport_mode"], "injected_test_only")
        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["execution"], False)
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)

    def test_pre_aborted_signal_prevents_transport_invocation_with_transport_aborted(self):
        result = self._node(f"""
import {{ ControlBotHttpSessionClient }} from './src/controlbot/http-session-client.ts';
let calls = 0;
const controller = new AbortController();
controller.abort('cancelled-before-dispatch');
const client = new ControlBotHttpSessionClient({{
  enabled: true,
  test_mode: true,
  test_transport: async (request) => {{
    calls += 1;
    return {{
      version: 1,
      request_fingerprint: request.request_fingerprint,
      status: 200,
      body: {{ ok: true }},
    }};
  }},
}});
let code = null;
try {{
  await client.poll({POLL_PAYLOAD}, {{ signal: controller.signal }});
}} catch (error) {{
  code = error?.code ?? null;
}}
console.log(JSON.stringify({{ calls, code }}));
""")
        self.assertEqual(result, {"calls": 0, "code": "transport_aborted"})

    def test_timeout_and_caller_abort_race_first_terminal_condition_wins_without_retry(self):
        result = self._node(f"""
import {{ ControlBotHttpSessionClient }} from './src/controlbot/http-session-client.ts';

async function runCase(timeoutMs, abortMs) {{
  const controller = new AbortController();
  let calls = 0;
  let transportAborted = false;
  const client = new ControlBotHttpSessionClient({{
    enabled: true,
    test_mode: true,
    timeout_ms: timeoutMs,
    test_transport: async (_request, signal) => {{
      calls += 1;
      signal?.addEventListener('abort', () => {{ transportAborted = true; }}, {{ once: true }});
      return await new Promise(() => {{}});
    }},
  }});
  const abortTimer = setTimeout(() => controller.abort(), abortMs);
  let code = null;
  try {{
    await client.poll({POLL_PAYLOAD}, {{ signal: controller.signal }});
  }} catch (error) {{
    code = error?.code ?? null;
  }} finally {{
    clearTimeout(abortTimer);
  }}
  return {{ code, calls, transport_aborted: transportAborted }};
}}

const callerFirst = await runCase(100, 10);
const timeoutFirst = await runCase(10, 100);
console.log(JSON.stringify({{ callerFirst, timeoutFirst }}));
""")
        self.assertEqual(result["callerFirst"]["code"], "transport_aborted")
        self.assertEqual(result["callerFirst"]["calls"], 1)
        self.assertIs(result["callerFirst"]["transport_aborted"], True)
        self.assertEqual(result["timeoutFirst"]["code"], "transport_timeout")
        self.assertEqual(result["timeoutFirst"]["calls"], 1)
        self.assertIs(result["timeoutFirst"]["transport_aborted"], True)

    def test_late_transport_completion_after_abort_cannot_become_success(self):
        result = self._node(f"""
import {{ ControlBotHttpSessionClient }} from './src/controlbot/http-session-client.ts';
const controller = new AbortController();
let resolveTransport;
let calls = 0;
const client = new ControlBotHttpSessionClient({{
  enabled: true,
  test_mode: true,
  timeout_ms: 500,
  test_transport: async (request) => {{
    calls += 1;
    return await new Promise((resolve) => {{
      resolveTransport = () => resolve({{
        version: 1,
        request_fingerprint: request.request_fingerprint,
        status: 200,
        body: {{ late: true }},
      }});
    }});
  }},
}});
const operation = client.poll({POLL_PAYLOAD}, {{ signal: controller.signal }})
  .then(() => 'success')
  .catch((error) => error?.code ?? 'unknown');
await new Promise((resolve) => setTimeout(resolve, 5));
controller.abort();
const terminal = await operation;
resolveTransport?.();
await new Promise((resolve) => setTimeout(resolve, 5));
console.log(JSON.stringify({{ terminal, calls }}));
""")
        self.assertEqual(result, {"terminal": "transport_aborted", "calls": 1})

    def test_deadline_v2_remains_injected_test_only_secret_free_and_non_executing(self):
        result = self._node(f"""
import {{ ControlBotHttpSessionClient }} from './src/controlbot/http-session-client.ts';
const caller = new AbortController();
let signalIsAbortSignal = false;
let signalIsComposed = false;
const client = new ControlBotHttpSessionClient({{
  enabled: true,
  test_mode: true,
  timeout_ms: 100,
  test_transport: async (request, signal) => {{
    signalIsAbortSignal = signal instanceof AbortSignal;
    signalIsComposed = signal !== caller.signal;
    return {{
      version: 1,
      request_fingerprint: request.request_fingerprint,
      status: 200,
      body: {{ ok: true }},
    }};
  }},
}});
const value = await client.poll({POLL_PAYLOAD}, {{ signal: caller.signal }});
console.log(JSON.stringify({{
  signalIsAbortSignal,
  signalIsComposed,
  transport_mode: value.transport_mode,
  authority: value.authority,
  execution: value.execution,
  network_access: value.network_access,
  external_mutation: value.external_mutation,
}}));
""")
        self.assertIs(result["signalIsAbortSignal"], True)
        self.assertIs(result["signalIsComposed"], True)
        self.assertEqual(result["transport_mode"], "injected_test_only")
        self.assertEqual(result["authority"], "unchanged")
        self.assertIs(result["execution"], False)
        self.assertIs(result["network_access"], False)
        self.assertIs(result["external_mutation"], False)
        lowered = self.source.lower()
        for forbidden in (
            "node:http", "node:https", "globalthis.fetch", "fetch(",
            "axios", "curl ", "wget ", "process.env",
            "writefile", "appendfile",
        ):
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
