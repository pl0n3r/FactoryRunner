"""E2E offline del transporte ControlBot de FactoryRunner #89."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerTransportE2ETests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { AdapterRegistry } from './src/adapters/programmatic.ts';
        import { ControlBotClient } from './src/controlbot/client.ts';
        import { CONTROLBOT_ROUTES } from './src/controlbot/connection-profile.ts';
        import { ControlBotHttpsTransport } from './src/controlbot/https-transport.ts';
        import { ExecutionLoop } from './src/execution-loop.ts';
        import { DurableJournal } from './src/journal.ts';
        import { parseRunnerHeartbeat, parseRunnerIdentity } from './src/runner.ts';

        const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
        const OTHER_RUNNER_ID = '99999999-9999-7999-8999-999999999999';
        const ORDER_ID = '22222222-2222-7222-8222-222222222222';
        const WORK_ITEM_ID = 'factoryrunner:work:89';
        const INSTRUCTION_REF = 'controlbot:instruction:factoryrunner-89';

        const profile = {
          version: 1,
          origin: 'https://control.example.test',
          routes: { ...CONTROLBOT_ROUTES },
          timeout_ms: 5000,
          backoff: { initial_ms: 100, max_ms: 1000, max_attempts: 3 },
          credential_ref: 'credential:controlbot-primary',
        };

        const identity = parseRunnerIdentity({
          version: 1,
          runner_id: RUNNER_ID,
          protocol_version: 1,
          runtime: 'node',
          runtime_version: '0.1.4',
          platform: 'linux-arm64',
          location: 'test',
          capabilities: ['git.head'],
          max_parallel: 1,
        });

        function order(runnerId = RUNNER_ID) {
          return {
            version: 1,
            order_id: ORDER_ID,
            work_item_id: WORK_ITEM_ID,
            runner_id: runnerId,
            capability: 'git.head',
            attempt: 1,
            issued_at: 1000,
            expires_at: 2000,
            instruction_ref: INSTRUCTION_REF,
          };
        }

        const calls = [];
        const delays = [];
        let pollAttempts = 0;
        const transport = new ControlBotHttpsTransport(
          profile,
          async (request) => {
            calls.push(request);
            if (request.url.endsWith(CONTROLBOT_ROUTES.poll)) {
              pollAttempts += 1;
              if (pollAttempts === 1) return { status: 503, body: null };
              return {
                status: 200,
                body: JSON.stringify({
                  version: 1,
                  cursor: 'controlbotcursor:after-89',
                  orders: [order()],
                }),
              };
            }
            return { status: 204, body: null };
          },
          async (delay) => { delays.push(delay); },
        );
        const client = new ControlBotClient(identity, transport);

        const polled = await client.poll(null, 4, 1500);
        const ack = await client.ack(ORDER_ID);
        const validated = client.validatedOrder(ORDER_ID);

        const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-e2e-89-'));
        let executed;
        let events;
        let published;
        try {
          const registry = new AdapterRegistry([{
            id: 'offline',
            capabilities: ['git.head'],
            async execute(capability) {
              return {
                capability,
                data: { ok: true },
                evidence: {
                  code: 'executed',
                  summary: 'Offline adapter completed',
                  ref: 'controlbot:evidence:factoryrunner-89',
                },
              };
            },
          }]);
          const eventIds = [
            '33333333-3333-7333-8333-333333333333',
            '44444444-4444-7444-8444-444444444444',
            '55555555-5555-7555-8555-555555555555',
          ];
          const path = join(directory, 'runner.ndjson');
          const loop = new ExecutionLoop({
            journal: new DurableJournal(path),
            registry,
            identity,
            now: () => 1500,
            event_id: () => eventIds.shift(),
          });
          executed = await loop.execute(validated, { timeout_ms: 100 });
          events = [...new DurableJournal(path).recover().events];
          published = await client.publishEvents(events);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }

        const heartbeat = parseRunnerHeartbeat({
          version: 1,
          runner_id: RUNNER_ID,
          sequence: 9,
          observed_at: 1501,
          status: 'ready',
          capacity: { max: 1, active: 0 },
          active_sessions: [],
        });
        const heartbeatPublished = await client.publishHeartbeat(heartbeat);

        const retryCalls = [];
        const retryDelays = [];
        const retryTransport = new ControlBotHttpsTransport(
          profile,
          async (request) => {
            retryCalls.push(request);
            return { status: 503, body: null };
          },
          async (delay) => { retryDelays.push(delay); },
        );
        const retryClient = new ControlBotClient(identity, retryTransport);
        let retryError = null;
        try {
          await retryClient.poll(null, 1, 1500);
        } catch (error) {
          retryError = error instanceof Error ? error.message : 'non-error';
        }

        const driftCalls = [];
        const driftTransport = new ControlBotHttpsTransport(
          profile,
          async (request) => {
            driftCalls.push(request);
            return {
              status: 200,
              body: JSON.stringify({
                version: 1,
                cursor: null,
                orders: [order(OTHER_RUNNER_ID)],
              }),
            };
          },
          async () => {},
        );
        const driftClient = new ControlBotClient(identity, driftTransport);
        let driftPollError = null;
        let driftAckError = null;
        try {
          await driftClient.poll(null, 1, 1500);
        } catch (error) {
          driftPollError = error instanceof Error ? error.message : 'non-error';
        }
        try {
          await driftClient.ack(ORDER_ID);
        } catch (error) {
          driftAckError = error instanceof Error ? error.message : 'non-error';
        }

        console.log(JSON.stringify({
          calls,
          delays,
          polled,
          ack,
          validated,
          executed,
          events,
          published,
          heartbeatPublished,
          retry: {
            error: retryError,
            calls: retryCalls,
            delays: retryDelays,
          },
          drift: {
            poll_error: driftPollError,
            ack_error: driftAckError,
            calls: driftCalls,
          },
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

    def test_offline_poll_ack_execute_events_heartbeat_flow_preserves_provenance(self):
        observed = self.observed
        self.assertEqual(observed["delays"], [100])
        self.assertEqual(
            [call["url"] for call in observed["calls"]],
            [
                "https://control.example.test/v1/runner/orders/poll",
                "https://control.example.test/v1/runner/orders/poll",
                "https://control.example.test/v1/runner/orders/ack",
                "https://control.example.test/v1/runner/events",
                "https://control.example.test/v1/runner/heartbeat",
            ],
        )

        polled = observed["polled"]["orders"][0]
        self.assertEqual(polled["order_id"], "22222222-2222-7222-8222-222222222222")
        self.assertEqual(polled["work_item_id"], "factoryrunner:work:89")
        self.assertEqual(polled["runner_id"], "11111111-1111-7111-8111-111111111111")
        self.assertNotIn("instruction_ref", polled)
        self.assertRegex(polled["fingerprint"], r"^[0-9a-f]{64}$")

        self.assertEqual(observed["ack"]["fingerprint"], polled["fingerprint"])
        self.assertEqual(observed["validated"]["instruction_ref"], "controlbot:instruction:factoryrunner-89")
        self.assertEqual(observed["executed"]["order"]["work_item_id"], "factoryrunner:work:89")
        self.assertEqual(observed["executed"]["event"]["state"], "completed")
        self.assertEqual(
            observed["executed"]["event"]["evidence"]["ref"],
            "controlbot:evidence:factoryrunner-89",
        )

        events = observed["events"]
        self.assertEqual([event["sequence"] for event in events], [1, 2, 3])
        self.assertEqual([event["state"] for event in events], ["accepted", "started", "completed"])
        self.assertEqual(
            {event["order_id"] for event in events},
            {"22222222-2222-7222-8222-222222222222"},
        )
        self.assertEqual(
            {event["runner_id"] for event in events},
            {"11111111-1111-7111-8111-111111111111"},
        )
        self.assertEqual(observed["published"], {"published": 3})
        self.assertEqual(observed["heartbeatPublished"], {"published": True, "sequence": 9})

        ack_body = json.loads(observed["calls"][2]["body"])
        event_body = json.loads(observed["calls"][3]["body"])
        heartbeat_body = json.loads(observed["calls"][4]["body"])
        self.assertEqual(ack_body["fingerprint"], polled["fingerprint"])
        self.assertEqual(event_body["events"][-1]["state"], "completed")
        self.assertEqual(heartbeat_body["heartbeat"]["sequence"], 9)

    def test_retry_exhaustion_or_identity_drift_never_emits_false_success(self):
        retry = self.observed["retry"]
        self.assertEqual(retry["error"], "controlbot_transport_failed")
        self.assertEqual(len(retry["calls"]), 3)
        self.assertEqual(retry["delays"], [100, 200])
        self.assertEqual(
            {call["url"] for call in retry["calls"]},
            {"https://control.example.test/v1/runner/orders/poll"},
        )

        drift = self.observed["drift"]
        self.assertEqual(drift["poll_error"], "controlbot_protocol_invalid")
        self.assertEqual(drift["ack_error"], "controlbot_protocol_invalid")
        self.assertEqual(len(drift["calls"]), 1)
        self.assertTrue(drift["calls"][0]["url"].endswith("/v1/runner/orders/poll"))

        serialized = json.dumps(self.observed)
        self.assertNotIn("private provider detail", serialized)
        self.assertNotIn("supersecret", serialized)


if __name__ == "__main__":
    unittest.main()
