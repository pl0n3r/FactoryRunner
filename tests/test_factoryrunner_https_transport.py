"""Aceptación ejecutable del transporte HTTPS ControlBot de FactoryRunner #87."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "https-transport.ts"


class FactoryRunnerHttpsTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import {
          CONTROLBOT_ROUTES,
        } from './src/controlbot/connection-profile.ts';
        import {
          ControlBotHttpsTransport,
        } from './src/controlbot/https-transport.ts';

        const profile = {
          version: 1,
          origin: 'https://control.example.test',
          routes: { ...CONTROLBOT_ROUTES },
          timeout_ms: 5000,
          backoff: { initial_ms: 100, max_ms: 1000, max_attempts: 3 },
          credential_ref: 'credential:controlbot-primary',
        };

        const calls = [];
        const delays = [];
        const executor = async (request) => {
          calls.push(request);
          if (request.url.endsWith(CONTROLBOT_ROUTES.poll)) {
            return {
              status: 200,
              body: JSON.stringify({ version: 1, cursor: null, orders: [] }),
            };
          }
          return { status: 204, body: null };
        };
        const transport = new ControlBotHttpsTransport(
          profile,
          executor,
          async (delay) => { delays.push(delay); },
        );

        const pollResult = await transport.poll({
          version: 1,
          runner_id: '11111111-1111-7111-8111-111111111111',
          capabilities: ['git.head'],
          cursor: null,
          limit: 4,
        });
        await transport.ack({
          version: 1,
          order_id: '22222222-2222-7222-8222-222222222222',
          runner_id: '11111111-1111-7111-8111-111111111111',
          fingerprint: 'a'.repeat(64),
        });
        await transport.publishEvents({
          version: 1,
          runner_id: '11111111-1111-7111-8111-111111111111',
          events: [],
        });
        await transport.publishHeartbeat({
          version: 1,
          runner_id: '11111111-1111-7111-8111-111111111111',
          heartbeat: {
            version: 1,
            runner_id: '11111111-1111-7111-8111-111111111111',
            sequence: 7,
            observed_at: 1200,
            status: 'ready',
            capacity: { max: 4, active: 0 },
            active_sessions: [],
          },
        });

        async function failureCase(executorFactory) {
          const observedCalls = [];
          const observedDelays = [];
          const failing = new ControlBotHttpsTransport(
            profile,
            async (request) => {
              observedCalls.push(request);
              return executorFactory(request);
            },
            async (delay) => { observedDelays.push(delay); },
          );
          let error = null;
          try {
            await failing.poll({
              version: 1,
              runner_id: '11111111-1111-7111-8111-111111111111',
              capabilities: ['git.head'],
              cursor: null,
              limit: 1,
            });
          } catch (caught) {
            error = caught instanceof Error ? caught.message : 'non-error';
          }
          return { error, calls: observedCalls.length, delays: observedDelays };
        }

        const timeout = await failureCase(async () => {
          throw new Error('timeout with private provider detail');
        });
        const unavailable = await failureCase(async () => ({
          status: 503,
          body: null,
        }));
        const badRequest = await failureCase(async () => ({
          status: 400,
          body: null,
        }));
        const sensitive = await failureCase(async () => ({
          status: 200,
          body: 'token=supersecretvalue',
        }));

        console.log(JSON.stringify({
          calls,
          delays,
          pollResult,
          timeout,
          unavailable,
          badRequest,
          sensitive,
        }));
        """
        output = subprocess.check_output(
            (
                "node",
                "--experimental-strip-types",
                "--input-type=module",
                "-e",
                script,
            ),
            cwd=ROOT,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=20,
        )
        cls.observed = json.loads(output)

    def test_transport_maps_poll_ack_events_and_heartbeat_to_closed_routes(self):
        observed = self.observed
        self.assertEqual(
            [call["url"] for call in observed["calls"]],
            [
                "https://control.example.test/v1/runner/orders/poll",
                "https://control.example.test/v1/runner/orders/ack",
                "https://control.example.test/v1/runner/events",
                "https://control.example.test/v1/runner/heartbeat",
            ],
        )
        self.assertEqual([call["method"] for call in observed["calls"]], ["POST"] * 4)
        self.assertEqual([call["attempt"] for call in observed["calls"]], [1] * 4)
        self.assertEqual(
            [call["credential_ref"] for call in observed["calls"]],
            ["credential:controlbot-primary"] * 4,
        )
        self.assertEqual([call["timeout_ms"] for call in observed["calls"]], [5000] * 4)
        self.assertEqual(observed["delays"], [])
        self.assertEqual(observed["pollResult"], {"version": 1, "cursor": None, "orders": []})

        bodies = [json.loads(call["body"]) for call in observed["calls"]]
        self.assertEqual(bodies[0]["limit"], 4)
        self.assertEqual(bodies[1]["version"], 1)
        self.assertEqual(bodies[2]["events"], [])
        self.assertEqual(bodies[3]["heartbeat"]["sequence"], 7)

        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "process.env",
            "writeFile",
            "appendFile",
        ):
            self.assertNotIn(forbidden, source)

    def test_transport_timeout_http_error_or_sensitive_output_fails_closed(self):
        timeout = self.observed["timeout"]
        self.assertEqual(timeout["error"], "controlbot_http_failed")
        self.assertEqual(timeout["calls"], 3)
        self.assertEqual(timeout["delays"], [100, 200])

        unavailable = self.observed["unavailable"]
        self.assertEqual(unavailable["error"], "controlbot_http_failed")
        self.assertEqual(unavailable["calls"], 3)
        self.assertEqual(unavailable["delays"], [100, 200])

        bad_request = self.observed["badRequest"]
        self.assertEqual(bad_request["error"], "controlbot_http_failed")
        self.assertEqual(bad_request["calls"], 1)
        self.assertEqual(bad_request["delays"], [])

        sensitive = self.observed["sensitive"]
        self.assertEqual(sensitive["error"], "controlbot_http_sensitive_output")
        self.assertEqual(sensitive["calls"], 1)
        self.assertEqual(sensitive["delays"], [])

        serialized = json.dumps(self.observed)
        self.assertNotIn("private provider detail", serialized)
        self.assertNotIn("supersecretvalue", serialized)


if __name__ == "__main__":
    unittest.main()
