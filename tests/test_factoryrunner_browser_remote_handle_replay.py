"""Aceptación del guard de replay del handle remoto en supervisor (#224)."""
import json, subprocess, unittest
from pathlib import Path as _Path

_ROOT = _Path(__file__).resolve().parents[1]
_FIXTURE_TEXT = (_Path(__file__).with_name(
    "test_factoryrunner_browser_remote_ack_drift.py"
)).read_text(encoding="utf-8")


def observe() -> dict[str, object]:
    opener, closer = '    script = r"""\n', '"""\n    raw = subprocess.check_output('
    before, found, tail = _FIXTURE_TEXT.partition(opener)
    script, closed, _after = tail.partition(closer)
    if before == _FIXTURE_TEXT or not found or not closed:
        raise AssertionError("fixture #204 cambió")
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
  let error = null;
  try {
    await configuredSupervisor(
      root, directory, counts, async () => {}, 220, true,
    ).tick(2);
  } catch (caught) {
    error = {
      name: caught instanceof Error ? caught.name : typeof caught,
      message: caught instanceof Error ? caught.message : String(caught),
    };
  }
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  rmSync(root, { recursive: true, force: true });
  return {
    error, counts, directoryReads, events, transportCalls: transport.calls,
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
        cwd=_ROOT,
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

    def test_duplicate_poll_batch_fails_before_remote_handle_can_replay_transport(self):
        duplicate = self.observed["duplicate"]
        self.assertEqual(duplicate["error"]["name"], "TypeError")
        self.assertIn("order_id duplicado", duplicate["error"]["message"])
        self.assertEqual(
            {key: duplicate[key] for key in ("counts", "directoryReads", "transportCalls", "events")},
            {
                "counts": {"ack": 0, "publish": 0, "placement": 0, "request": 0},
                "directoryReads": 0,
                "transportCalls": 0,
                "events": [],
            },
        )

    def test_terminal_recovery_revalidates_local_contracts_without_ack_or_handle_transport_replay(self):
        recovery = self.observed["recovery"]
        self.assertEqual(recovery["firstTransportCalls"], 1)
        self.assertEqual(recovery["restartTransportCalls"], 0)
        self.assertEqual(
            {key: recovery["restartCounts"][key] for key in ("placement", "request", "ack", "publish")},
            {"placement": 1, "request": 1, "ack": 0, "publish": 0},
        )
        self.assertEqual(recovery["events"], ["accepted", "started", "completed"])
