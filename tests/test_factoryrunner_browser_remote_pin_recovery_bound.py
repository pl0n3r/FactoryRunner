"""Aceptación de boundedness del registry de pins browser remotos (#232)."""
import json, subprocess, unittest
from pathlib import Path as _Path

_ROOT = _Path(__file__).resolve().parents[1]
_FIXTURE = (_Path(__file__).with_name(
    "test_factoryrunner_browser_remote_ack_drift.py"
)).read_text(encoding="utf-8")


def observe() -> dict[str, object]:
    opener, closer = '    script = r"""\n', '"""\n    raw = subprocess.check_output('
    _head, found, tail = _FIXTURE.partition(opener)
    script, closed, _rest = tail.partition(closer)
    if not found or not closed:
        raise AssertionError("fixture #204 cambió")

    script = script.replace(
        "function requestFor(p) {",
        "function requestFor(p, suffix = 'ack-drift-204') {",
        1,
    ).replace(
        "payload: { url: 'https://example.com/ack-drift-204' },",
        "payload: { url: `https://example.com/${suffix}` },",
        1,
    ).replace(
        "function configuredSupervisor(root, directory, counts, onAck, seed) {",
        "function configuredSupervisor(root, directory, counts, onAck, seed, options = {}) {",
        1,
    ).replace(
        """      async ack() {
        counts.ack += 1;
        await onAck();
      },""",
        """      async ack() {
        counts.ack += 1;
        await onAck();
        if (options.failAck === true) throw new Error('ack-pre-dispatch-failed');
      },""",
        1,
    ).replace(
        """    browser_request: () => {
      counts.request += 1;
      return request;
    },""",
        """    browser_request: () => {
      counts.request += 1;
      const suffix = options.requestSuffixes?.shift();
      return suffix === undefined ? request : requestFor(p, suffix);
    },""",
        1,
    )

    scenarios = r"""
async function repeatedFailuresBounded() {
  const root = mkdtempSync(join(tmpdir(), 'fr232-bounded-failures-'));
  const transport = new Transport('bounded-failures');
  const directory = new BrowserRemoteDirectory();
  directory.register({ profile: remoteProfile('browser-primary'), transport });
  const rawEntries = directory.entries.bind(directory);
  let directoryReads = 0;
  const installEntries = () => {
    directory.entries = () => {
      directoryReads += 1;
      return rawEntries();
    };
  };
  installEntries();

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {},
    232,
    {
      failAck: true,
      requestSuffixes: ['bound-a', 'bound-b', 'bound-a'],
    },
  );

  const errors = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runtime.tick(1);
      errors.push(null);
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
    installEntries();
  }

  const observed = {
    errors,
    counts,
    directoryReads,
    transportCalls: transport.calls,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function terminalRecoveryBounded() {
  const root = mkdtempSync(join(tmpdir(), 'fr232-terminal-bound-'));
  const transport = new Transport('terminal-bound');
  const directory = new BrowserRemoteDirectory();
  directory.register({ profile: remoteProfile('browser-primary'), transport });
  const rawEntries = directory.entries.bind(directory);
  let directoryReads = 0;
  const installEntries = () => {
    directory.entries = () => {
      directoryReads += 1;
      return rawEntries();
    };
  };
  installEntries();

  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {},
    330,
  );
  const first = await runtime.tick(1);
  const afterFirst = {
    counts: { ...counts },
    directoryReads,
    transportCalls: transport.calls,
  };

  installEntries();
  const recovery = await runtime.tick(1);
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);

  const observed = {
    first,
    afterFirst,
    recovery,
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
    script = script.replace(marker, scenarios + marker, 1).replace(
        "console.log(JSON.stringify({\n  drift: await driftDuringAck(),",
        "console.log(JSON.stringify({"
        "\n  repeatedFailuresBounded: await repeatedFailuresBounded(),"
        "\n  terminalRecoveryBounded: await terminalRecoveryBounded(),"
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


class FactoryRunnerBrowserRemotePinRecoveryBoundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_repeated_pre_dispatch_failures_leave_registry_bounded_at_zero(self):
        failure = self.observed["repeatedFailuresBounded"]
        self.assertEqual(failure["errors"], ["ack-pre-dispatch-failed"] * 3)
        self.assertEqual(
            failure["counts"],
            {"ack": 3, "publish": 0, "placement": 3, "request": 3},
        )
        self.assertEqual(failure["directoryReads"], 6)
        self.assertEqual(failure["transportCalls"], 0)

    def test_terminal_recovery_does_not_retain_or_replay_abandoned_handle(self):
        recovery = self.observed["terminalRecoveryBounded"]
        self.assertEqual(recovery["first"], {"processed": 1, "cursor": None})
        self.assertEqual(
            recovery["afterFirst"],
            {
                "counts": {"ack": 1, "publish": 1, "placement": 1, "request": 1},
                "directoryReads": 2,
                "transportCalls": 1,
            },
        )
        self.assertEqual(recovery["recovery"], {"processed": 1, "cursor": None})
        self.assertEqual(
            recovery["counts"],
            {"ack": 1, "publish": 1, "placement": 2, "request": 2},
        )
        self.assertEqual(recovery["directoryReads"], 4)
        self.assertEqual(recovery["transportCalls"], 1)
        self.assertEqual(recovery["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
