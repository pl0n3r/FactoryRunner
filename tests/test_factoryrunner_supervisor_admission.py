"""Aceptación ejecutable del gate de admisión en RuntimeSupervisor #97."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerSupervisorAdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { AdapterRegistry } from './src/adapters/programmatic.ts';
        import { capabilityManifest } from './src/capability-manifest.ts';
        import { ControlBotClient } from './src/controlbot/client.ts';
        import { executionAdmissionDecision } from './src/execution-admission.ts';
        import { ExecutionLoop } from './src/execution-loop.ts';
        import { DurableJournal } from './src/journal.ts';
        import { DurableOutbox } from './src/outbox.ts';
        import { resourceSnapshot } from './src/resource-snapshot.ts';
        import { RuntimeSupervisor } from './src/runtime-supervisor.ts';

        const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
        const ORDER_ID = '22222222-2222-7222-8222-222222222222';
        const NOW = 1200;
        const identity = {
          version: 1,
          runner_id: RUNNER_ID,
          protocol_version: 1,
          runtime: 'node',
          runtime_version: '0.1.4',
          platform: 'linux-arm64',
          location: 'test',
          capabilities: ['git.head'],
          max_parallel: 1,
        };
        const order = {
          version: 1,
          order_id: ORDER_ID,
          work_item_id: 'factoryrunner:work:97',
          runner_id: RUNNER_ID,
          capability: 'git.head',
          attempt: 1,
          issued_at: 1100,
          expires_at: 1300,
          instruction_ref: 'controlbot:instruction:factoryrunner-97',
        };
        const adapters = [{
          id: 'git-adapter',
          capabilities: ['git.head'],
          async execute(capability) {
            return {
              capability,
              data: { ok: true },
              evidence: {
                code: 'executed',
                summary: 'Synthetic adapter completed',
                ref: null,
              },
            };
          },
        }];
        const manifest = capabilityManifest(identity, adapters);

        function resource(active = 0, status = 'ready') {
          return resourceSnapshot(
            identity,
            {
              version: 1,
              runner_id: RUNNER_ID,
              sequence: 7,
              observed_at: 1190,
              status,
              capacity: { max: 1, active },
              active_sessions: active === 0 ? [] : ['factoryrunner:external:busy'],
            },
            {
              version: 1,
              runner_id: RUNNER_ID,
              observed_at: 1190,
              queued_orders: 1,
            },
            NOW,
            30,
          );
        }

        async function scenario(kind) {
          const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-admission-97-'));
          const journal = new DurableJournal(join(directory, 'journal.ndjson'));
          const outbox = new DurableOutbox(join(directory, 'outbox.ndjson'));
          const counts = { poll: 0, ack: 0, execute: 0, publish: 0 };
          const activeAtGate = [];

          const transport = {
            async poll() {
              counts.poll += 1;
              return { version: 1, cursor: null, orders: [order] };
            },
            async ack() {
              counts.ack += 1;
            },
            async publishEvents() {
              counts.publish += 1;
            },
            async publishHeartbeat() {},
          };

          const registry = new AdapterRegistry([{
            ...adapters[0],
            async execute(capability) {
              counts.execute += 1;
              return adapters[0].execute(capability);
            },
          }]);
          const client = new ControlBotClient(identity, transport);
          const eventIds = [
            '33333333-3333-7333-8333-333333333333',
            '44444444-4444-7444-8444-444444444444',
            '55555555-5555-7555-8555-555555555555',
            '66666666-6666-7666-8666-666666666666',
          ];
          const loop = new ExecutionLoop({
            journal,
            registry,
            identity,
            now: () => NOW,
            event_id: () => eventIds.shift() ?? '77777777-7777-7777-8777-777777777777',
          });

          let supervisor;
          const fresh = resource();
          const zero = resource(1, 'busy');
          const admission = (validated, now) => {
            activeAtGate.push(supervisor.heartbeat(identity, activeAtGate.length + 1).capacity.active);
            const resources = kind === 'wait'
              ? zero
              : kind === 'blocked'
                ? { ...fresh, freshness: 'stale' }
                : fresh;
            return executionAdmissionDecision(
              identity,
              validated,
              manifest,
              resources,
              now,
            );
          };

          supervisor = new RuntimeSupervisor({
            client,
            journal,
            outbox,
            loop,
            admission,
            now: () => NOW,
            event_id: () => '88888888-8888-7888-8888-888888888888',
          });

          try {
            const first = await supervisor.tick(1);
            const afterFirst = {
              heartbeat: supervisor.heartbeat(identity, 20),
              events: journal.recover().events,
              delivered: outbox.recover().delivered,
              counts: { ...counts },
            };
            let second = null;
            let afterSecond = null;
            if (kind === 'allow') {
              second = await supervisor.tick(1);
              afterSecond = {
                events: journal.recover().events,
                delivered: outbox.recover().delivered,
                counts: { ...counts },
              };
            }
            return { first, second, afterFirst, afterSecond, activeAtGate };
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }

        const wait = await scenario('wait');
        const blocked = await scenario('blocked');
        const allow = await scenario('allow');
        console.log(JSON.stringify({ wait, blocked, allow }));
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

    def test_wait_or_block_never_starts_adapter_or_consumes_execution_slot(self):
        for key in ("wait", "blocked"):
            with self.subTest(case=key):
                observed = self.observed[key]
                self.assertEqual(observed["first"], {"processed": 0, "cursor": None})
                self.assertEqual(observed["activeAtGate"], [0])
                self.assertEqual(
                    observed["afterFirst"]["counts"],
                    {"poll": 1, "ack": 0, "execute": 0, "publish": 0},
                )
                self.assertEqual(observed["afterFirst"]["events"], [])
                self.assertEqual(observed["afterFirst"]["delivered"], [])
                self.assertEqual(
                    observed["afterFirst"]["heartbeat"]["capacity"]["active"],
                    0,
                )

    def test_allow_preserves_existing_idempotent_supervisor_flow(self):
        observed = self.observed["allow"]
        self.assertEqual(observed["first"], {"processed": 1, "cursor": None})
        self.assertEqual(observed["second"], {"processed": 1, "cursor": None})
        self.assertEqual(observed["activeAtGate"], [0, 0])
        self.assertEqual(
            observed["afterFirst"]["counts"],
            {"poll": 1, "ack": 1, "execute": 1, "publish": 1},
        )
        self.assertEqual(
            observed["afterSecond"]["counts"],
            {"poll": 2, "ack": 1, "execute": 1, "publish": 1},
        )
        self.assertEqual(
            [event["state"] for event in observed["afterSecond"]["events"]],
            ["accepted", "started", "completed"],
        )
        self.assertEqual(len(observed["afterSecond"]["delivered"]), 2)


if __name__ == "__main__":
    unittest.main()
