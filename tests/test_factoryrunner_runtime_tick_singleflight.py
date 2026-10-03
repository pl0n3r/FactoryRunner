"""Aceptación ejecutable del single-flight de RuntimeSupervisor (FactoryRunner #238)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FactoryRunnerRuntimeTickSingleFlightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import { RuntimeSupervisor } from './src/runtime-supervisor.ts';

        const noopJournal = {
          recover() { return { orders: [], events: [] }; },
          appendOrder() {},
          appendEvent() {},
        };
        const noopOutbox = {
          recover() { return { pending: [], delivered: [] }; },
        };
        const noopLoop = {};

        async function concurrentScenario() {
          let polls = 0;
          let enterPoll;
          let releasePoll;
          const entered = new Promise((resolve) => { enterPoll = resolve; });
          const heldPoll = new Promise((resolve) => { releasePoll = resolve; });
          const client = {
            async poll() {
              polls += 1;
              enterPoll();
              return heldPoll;
            },
          };
          const supervisor = new RuntimeSupervisor({
            client,
            journal: noopJournal,
            outbox: noopOutbox,
            loop: noopLoop,
            now: () => 1000,
          });

          const first = supervisor.tick(1);
          await entered;
          let concurrentError = null;
          try {
            await supervisor.tick(1);
          } catch (error) {
            concurrentError = { name: error.name, message: error.message };
          }
          releasePoll({ version: 1, cursor: 'cursor-1', orders: [] });
          return { polls, concurrentError, first: await first };
        }

        async function releaseScenario() {
          let polls = 0;
          const client = {
            async poll() {
              polls += 1;
              if (polls === 1) throw new Error('synthetic poll failure');
              return { version: 1, cursor: 'cursor-ok', orders: [] };
            },
          };
          const supervisor = new RuntimeSupervisor({
            client,
            journal: noopJournal,
            outbox: noopOutbox,
            loop: noopLoop,
            now: () => 1000,
          });

          let firstError = null;
          try {
            await supervisor.tick(1);
          } catch (error) {
            firstError = error.message;
          }
          const afterFailure = await supervisor.tick(1);
          const afterSuccess = await supervisor.tick(1);
          return { polls, firstError, afterFailure, afterSuccess };
        }

        console.log(JSON.stringify({
          concurrent: await concurrentScenario(),
          release: await releaseScenario(),
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

    def test_concurrent_tick_fails_closed_before_second_poll(self):
        observed = self.observed["concurrent"]
        self.assertEqual(observed["polls"], 1)
        self.assertEqual(observed["concurrentError"]["name"], "TypeError")
        self.assertIn("ya está en ejecución", observed["concurrentError"]["message"])
        self.assertEqual(
            observed["first"],
            {"processed": 0, "cursor": "cursor-1"},
        )

    def test_tick_guard_releases_after_success_or_failure(self):
        observed = self.observed["release"]
        self.assertEqual(observed["polls"], 3)
        self.assertEqual(observed["firstError"], "synthetic poll failure")
        self.assertEqual(
            observed["afterFailure"],
            {"processed": 0, "cursor": "cursor-ok"},
        )
        self.assertEqual(
            observed["afterSuccess"],
            {"processed": 0, "cursor": "cursor-ok"},
        )


if __name__ == "__main__":
    unittest.main()
