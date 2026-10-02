"""Aceptación del guard de replay del handle remoto en supervisor (#224)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_TEST = ROOT / "tests" / "test_factoryrunner_browser_remote_ack_drift.py"


def observe() -> dict[str, object]:
    source = BASE_TEST.read_text(encoding="utf-8")
    prefix = '    script = r"""\n'
    suffix = '"""\n    raw = subprocess.check_output('
    if source.count(prefix) != 1 or source.count(suffix) != 1:
        raise AssertionError("fixture #204 no tiene la forma esperada")
    script = source.split(prefix, 1)[1].split(suffix, 1)[0]

    script = script.replace(
        "function configuredSupervisor(root, directory, counts, onAck, seed) {",
        "function configuredSupervisor(root, directory, counts, onAck, seed, duplicate = false) {",
        1,
    )
    script = script.replace(
        "orders: [{ ...order, fingerprint: orderHash }],",
        "orders: duplicate\n"
        "            ? [{ ...order, fingerprint: orderHash }, { ...order, fingerprint: orderHash }]\n"
        "            : [{ ...order, fingerprint: orderHash }],",
        1,
    )

    marker = "async function recovery() {"
    duplicate = r"""
async function duplicateRequest() {
  const root = mkdtempSync(join(tmpdir(), 'fr224-duplicate-'));
  const transport = new Transport('duplicate');
  const directory = new BrowserRemoteDirectory();
  directory.register({
    profile: remoteProfile('browser-primary'),
    transport,
  });

  const originalEntries = directory.entries.bind(directory);
  let directoryReads = 0;
  directory.entries = () => {
    directoryReads += 1;
    return originalEntries();
  };

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {},
    220,
    true,
  );
  const result = await runtime.tick(2);
  const events = new DurableJournal(join(root, 'journal.ndjson')).recover().events;
  const observed = {
    result,
    counts,
    directoryReads,
    transportCalls: transport.calls,
    events: events.map((event) => event.state),
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

"""
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: no se encontró recovery()")
    script = script.replace(marker, duplicate + marker, 1)
    script = script.replace(
        "console.log(JSON.stringify({\n  drift: await driftDuringAck(),",
        "console.log(JSON.stringify({\n  duplicate: await duplicateRequest(),\n  drift: await driftDuringAck(),",
        1,
    )

    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteHandleReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_consumes_exact_handle_once_and_duplicate_request_cannot_replay_transport(self):
        duplicate = self.observed["duplicate"]
        self.assertEqual(duplicate["result"], {"processed": 2, "cursor": None})
        self.assertEqual(
            duplicate["counts"],
            {"ack": 1, "publish": 1, "placement": 2, "request": 2},
        )
        self.assertEqual(duplicate["directoryReads"], 3)
        self.assertEqual(duplicate["transportCalls"], 1)
        self.assertEqual(duplicate["events"], ["accepted", "started", "completed"])

    def test_terminal_recovery_revalidates_local_contracts_without_ack_or_handle_transport_replay(self):
        recovery = self.observed["recovery"]
        self.assertEqual(recovery["firstTransportCalls"], 1)
        self.assertEqual(recovery["restartTransportCalls"], 0)
        self.assertEqual(recovery["restartCounts"]["placement"], 1)
        self.assertEqual(recovery["restartCounts"]["request"], 1)
        self.assertEqual(recovery["restartCounts"]["ack"], 0)
        self.assertEqual(recovery["restartCounts"]["publish"], 0)
        self.assertEqual(recovery["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
