"""Aceptación del guard de replay del handle remoto en supervisor (#224)."""
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "tests" / "test_factoryrunner_browser_remote_ack_drift.py"


def _script_fixture() -> str:
    source = BASE.read_text(encoding="utf-8")
    start = '    script = r"""\n'
    end = '"""\n    raw = subprocess.check_output('
    if source.count(start) != 1 or source.count(end) != 1:
        raise AssertionError("fixture #204 cambió")
    return source.split(start, 1)[1].split(end, 1)[0]


def observe() -> dict[str, object]:
    script = _script_fixture()
    script = script.replace(
        "function configuredSupervisor(root, directory, counts, onAck, seed) {",
        "function configuredSupervisor(root, directory, counts, onAck, seed, duplicate = false) {",
        1,
    )
    script = script.replace(
        "orders: [{ ...order, fingerprint: orderHash }],",
        "orders: duplicate ? "
        "[{ ...order, fingerprint: orderHash }, { ...order, fingerprint: orderHash }] "
        ": [{ ...order, fingerprint: orderHash }],",
        1,
    )

    duplicate_case = r"""
async function duplicateRequest() {
  const root = mkdtempSync(join(tmpdir(), 'fr224-duplicate-'));
  const transport = new Transport('duplicate');
  const directory = new BrowserRemoteDirectory();
  directory.register({ profile: remoteProfile('browser-primary'), transport });
  const originalEntries = directory.entries.bind(directory);
  let directoryReads = 0;
  directory.entries = () => { directoryReads += 1; return originalEntries(); };
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const result = await configuredSupervisor(
    root, directory, counts, async () => {}, 220, true,
  ).tick(2);
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  rmSync(root, { recursive: true, force: true });
  return {
    result, counts, directoryReads, events, transportCalls: transport.calls,
  };
}

"""
    marker = "async function recovery() {"
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: recovery ausente")
    script = script.replace(marker, duplicate_case + marker, 1)
    script = script.replace(
        "console.log(JSON.stringify({\n  drift: await driftDuringAck(),",
        "console.log(JSON.stringify({\n  duplicate: await duplicateRequest(),"
        "\n  drift: await driftDuringAck(),",
        1,
    )

    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteHandleReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_supervisor_consumes_exact_handle_once_and_duplicate_request_cannot_replay_transport(self):
        duplicate = self.observed["duplicate"]
        expected = {
            "result": {"processed": 2, "cursor": None},
            "counts": {"ack": 1, "publish": 1, "placement": 2, "request": 2},
            "directoryReads": 3,
            "transportCalls": 1,
            "events": ["accepted", "started", "completed"],
        }
        self.assertEqual(duplicate, expected)

    def test_terminal_recovery_revalidates_local_contracts_without_ack_or_handle_transport_replay(self):
        recovery = self.observed["recovery"]
        self.assertEqual(recovery["firstTransportCalls"], 1)
        self.assertEqual(recovery["restartTransportCalls"], 0)
        self.assertEqual(
            {key: recovery["restartCounts"][key] for key in ("placement", "request", "ack", "publish")},
            {"placement": 1, "request": 1, "ack": 0, "publish": 0},
        )
        self.assertEqual(recovery["events"], ["accepted", "started", "completed"])
