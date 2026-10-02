"""Aceptación del cleanup de pins browser remotos antes de dispatch (#231)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "test_factoryrunner_browser_remote_ack_drift.py"


def _fixture_script() -> str:
    source = FIXTURE.read_text(encoding="utf-8")
    opener = '    script = r"""\n'
    closer = '"""\n    raw = subprocess.check_output('
    head, found, tail = source.partition(opener)
    script, closed, _rest = tail.partition(closer)
    if head == source or not found or not closed:
        raise AssertionError("fixture #204 cambió")
    return script


def observe() -> dict[str, object]:
    script = _fixture_script()
    script = script.replace(
        "function configuredSupervisor(root, directory, counts, onAck, seed) {",
        "function configuredSupervisor(root, directory, counts, onAck, seed, failFirstAck = false) {",
        1,
    )
    script = script.replace(
        """      async ack() {
        counts.ack += 1;
        await onAck();
      },""",
        """      async ack() {
        counts.ack += 1;
        if (failFirstAck && counts.ack === 1) throw new Error('ack-pre-dispatch-failed');
        await onAck();
      },""",
        1,
    )

    scenario = r"""
async function abortCleanup() {
  const root = mkdtempSync(join(tmpdir(), 'fr231-abort-cleanup-'));
  const transport = new Transport('primary');
  const directory = new BrowserRemoteDirectory();
  directory.register({
    profile: remoteProfile('browser-primary'),
    transport,
  });

  const rawEntries = directory.entries.bind(directory);
  let directoryReads = 0;
  directory.entries = () => {
    directoryReads += 1;
    return rawEntries();
  };

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {},
    231,
    true,
  );

  let firstError = null;
  try {
    await runtime.tick(1);
  } catch (caught) {
    firstError = caught instanceof Error ? caught.message : String(caught);
  }
  const afterFirst = {
    counts: { ...counts },
    directoryReads,
    transportCalls: transport.calls,
  };

  directory.entries = () => {
    directoryReads += 1;
    return rawEntries();
  };

  const retry = await runtime.tick(1);
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  const observed = {
    firstError,
    afterFirst,
    retry,
    counts,
    directoryReads,
    transportCalls: transport.calls,
    events,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

"""
    marker = "async function recovery() {"
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: recovery ausente")
    script = script.replace(marker, scenario + marker, 1)
    script = script.replace(
        "console.log(JSON.stringify({\n  drift: await driftDuringAck(),",
        "console.log(JSON.stringify({\n  abortCleanup: await abortCleanup(),"
        "\n  drift: await driftDuringAck(),",
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


class FactoryRunnerBrowserRemotePinAbortCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()["abortCleanup"]

    def test_ack_failure_drops_pinned_handle_before_adapter_dispatch(self):
        self.assertEqual(self.observed["firstError"], "ack-pre-dispatch-failed")
        self.assertEqual(
            self.observed["afterFirst"],
            {
                "counts": {"ack": 1, "publish": 0, "placement": 1, "request": 1},
                "directoryReads": 2,
                "transportCalls": 0,
            },
        )

    def test_retry_after_pre_dispatch_failure_uses_fresh_handle_without_replay(self):
        self.assertEqual(self.observed["retry"], {"processed": 1, "cursor": None})
        self.assertEqual(
            self.observed["counts"],
            {"ack": 2, "publish": 1, "placement": 2, "request": 2},
        )
        self.assertEqual(self.observed["directoryReads"], 4)
        self.assertEqual(self.observed["transportCalls"], 1)
        self.assertEqual(self.observed["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
