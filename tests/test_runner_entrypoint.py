"""Aceptación ejecutable #575: npm start con ControlBot falso en loopback."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER_ID = "11111111-1111-7111-8111-111111111111"


class RunnerEntrypointTests(unittest.TestCase):
    def test_acceptance(self):
        requests = []

        class ControlBotMock(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                pass

            def do_POST(self):
                size = int(self.headers.get("content-length", "0"))
                if size < 1 or size > 4096:
                    self.send_response(400)
                    self.end_headers()
                    return
                content = json.loads(self.rfile.read(size))
                requests.append((self.path, content))
                if self.path == "/v1/runner/orders/poll":
                    answer = json.dumps({
                        "version": 1, "cursor": None, "orders": []
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(answer)))
                    self.end_headers()
                    self.wfile.write(answer)
                elif self.path == "/v1/runner/heartbeat":
                    self.send_response(204)
                    self.end_headers()
                else:
                    self.send_response(404)
                    self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), ControlBotMock)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="runner-575-") as folder:
                config = {
                    "identity": {
                        "version": 1, "runner_id": RUNNER_ID,
                        "protocol_version": 1, "runtime": "node",
                        "runtime_version": "24.0.0", "platform": "linux",
                        "location": "mock", "capabilities": ["git.head"],
                        "max_parallel": 1
                    },
                    "origin": f"http://127.0.0.1:{server.server_port}",
                    "journal_path": str(Path(folder) / "journal.ndjson"),
                    "outbox_path": str(Path(folder) / "outbox.ndjson"),
                    "cycles": 1,
                }
                env = {**os.environ, "FACTORYRUNNER_TEST_CONFIG": json.dumps(config)}
                proc = subprocess.run(
                    ["npm", "start", "--silent"],
                    cwd=ROOT, env=env, text=True, capture_output=True,
                    timeout=30, check=False,
                )
            self.assertEqual(proc.returncode, 0, (proc.stdout, proc.stderr))
            self.assertEqual(proc.stderr, "")
            result = json.loads(proc.stdout)
            self.assertEqual(result["status"], "runner_completed")
            self.assertEqual(result["runner_id"], RUNNER_ID)
            self.assertEqual((result["ticks"], result["processed"], result["drained"]),
                             (1, 0, True))
            self.assertEqual(
                [route for route, _ in requests],
                ["/v1/runner/heartbeat",
                 "/v1/runner/orders/poll",
                 "/v1/runner/heartbeat"],
            )
            first, poll, last = (payload for _, payload in requests)
            self.assertEqual(first["heartbeat"]["status"], "ready")
            self.assertEqual(last["heartbeat"]["status"], "draining")
            self.assertEqual((first["heartbeat"]["sequence"],
                              last["heartbeat"]["sequence"]), (1, 2))
            self.assertEqual(poll["runner_id"], RUNNER_ID)
            self.assertEqual(poll["capabilities"], ["git.head"])
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_reject_external_origin_without_network(self):
        with tempfile.TemporaryDirectory(prefix="runner-575-invalid-") as folder:
            config = {
                "identity": {
                    "version": 1, "runner_id": RUNNER_ID,
                    "protocol_version": 1, "runtime": "node",
                    "runtime_version": "24.0.0", "platform": "linux",
                    "location": "mock", "capabilities": ["git.head"],
                    "max_parallel": 1
                },
                "origin": "https://example.invalid",
                "journal_path": str(Path(folder) / "journal.ndjson"),
                "outbox_path": str(Path(folder) / "outbox.ndjson"),
                "cycles": 1,
            }
            result = subprocess.run(
                ["npm", "start", "--silent"],
                cwd=ROOT,
                env={**os.environ, "FACTORYRUNNER_TEST_CONFIG": json.dumps(config)},
                text=True, capture_output=True, check=False, timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr.strip(), "runner_failed")
            self.assertNotIn("example.invalid", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
