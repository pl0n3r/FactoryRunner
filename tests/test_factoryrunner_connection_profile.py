"""Aceptación ejecutable del perfil de conexión ControlBot de FactoryRunner #86."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "controlbot" / "connection-profile.ts"


class FactoryRunnerConnectionProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = r"""
        import {
          CONTROLBOT_ROUTES,
          parseControlBotConnectionProfile,
        } from './src/controlbot/connection-profile.ts';

        const valid = {
          version: 1,
          origin: 'https://control.example.test',
          routes: { ...CONTROLBOT_ROUTES },
          timeout_ms: 5000,
          backoff: { initial_ms: 250, max_ms: 4000, max_attempts: 4 },
          credential_ref: 'credential:controlbot-primary',
        };
        const profile = parseControlBotConnectionProfile(valid);

        const invalid = [
          { ...valid, origin: 'http://control.example.test' },
          { ...valid, origin: 'https://user@control.example.test' },
          { ...valid, origin: 'https://control.example.test/api' },
          { ...valid, origin: 'https://control.example.test?x=1' },
          { ...valid, origin: 'https://control.example.test#frag' },
          { ...valid, routes: { ...valid.routes, poll: '/admin/delete' } },
          { ...valid, routes: { ...valid.routes, extra: '/v1/runner/extra' } },
          { ...valid, credential_ref: 'plain-secret-value' },
          { ...valid, credential_ref: 'credential:token=supersecretvalue' },
          { ...valid, timeout_ms: 0 },
          {
            ...valid,
            backoff: { initial_ms: 5000, max_ms: 1000, max_attempts: 4 },
          },
          { ...valid, unexpected: true },
        ];
        const rejected = invalid.map((item) => {
          try {
            parseControlBotConnectionProfile(item);
            return false;
          } catch {
            return true;
          }
        });

        console.log(JSON.stringify({ profile, rejected }));
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

    def test_profile_is_https_closed_and_secret_free(self):
        profile = self.observed["profile"]
        self.assertEqual(profile["version"], 1)
        self.assertEqual(profile["origin"], "https://control.example.test")
        self.assertEqual(
            profile["routes"],
            {
                "poll": "/v1/runner/orders/poll",
                "ack": "/v1/runner/orders/ack",
                "events": "/v1/runner/events",
                "heartbeat": "/v1/runner/heartbeat",
            },
        )
        self.assertEqual(profile["timeout_ms"], 5000)
        self.assertEqual(profile["backoff"]["max_attempts"], 4)
        self.assertEqual(
            profile["credential_ref"],
            "credential:controlbot-primary",
        )
        self.assertEqual(profile["authority"], "unchanged")
        self.assertFalse(profile["network_access"])

        serialized = json.dumps(profile)
        for forbidden in ("Bearer ", "password=", "token=", "PRIVATE KEY"):
            self.assertNotIn(forbidden, serialized)

        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "node:http",
            "node:https",
            "fetch(",
            "process.env",
            "writeFile",
        ):
            self.assertNotIn(forbidden, source)

    def test_invalid_origin_route_or_credential_reference_fails_closed(self):
        self.assertEqual(self.observed["rejected"], [True] * 12)


if __name__ == "__main__":
    unittest.main()
