"""Aceptación del ownership de cleanup de pins por tick (FactoryRunner #239)."""
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
    import_anchor = (
        "import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';\n"
    )
    if script.count(import_anchor) != 1:
        raise AssertionError("fixture #204 cambió: import directory")
    script = script.replace(
        import_anchor,
        import_anchor
        + "import { BrowserRemotePinRegistry } from './src/browser-remote-pin-registry.ts';\n",
        1,
    )

    scenario = r"""
async function tickPinOwnership() {
  const root = mkdtempSync(join(tmpdir(), 'fr239-tick-pin-owner-'));
  const transport = new Transport('owner');
  const directory = new BrowserRemoteDirectory();
  directory.register({
    profile: remoteProfile('browser-primary'),
    transport,
  });

  let ackEnteredResolve;
  let releaseAckResolve;
  const ackEntered = new Promise((resolve) => { ackEnteredResolve = resolve; });
  const releaseAck = new Promise((resolve) => { releaseAckResolve = resolve; });
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };

  const originalDrop = BrowserRemotePinRegistry.prototype.drop;
  const drops = [];
  BrowserRemotePinRegistry.prototype.drop = function(requestFingerprint) {
    drops.push(requestFingerprint);
    return originalDrop.call(this, requestFingerprint);
  };

  const expectedRequest = requestFor(plan(admission()));
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {
      ackEnteredResolve();
      await releaseAck;
    },
    239,
  );

  const first = runtime.tick(1);
  await ackEntered;

  let concurrentError = null;
  try {
    await runtime.tick(1);
  } catch (caught) {
    concurrentError = {
      name: caught instanceof Error ? caught.name : typeof caught,
      message: caught instanceof Error ? caught.message : String(caught),
    };
  }
  const dropsWhileOwnerActive = [...drops];

  releaseAckResolve();
  let ownerResult = null;
  let ownerError = null;
  try {
    ownerResult = await first;
  } catch (caught) {
    ownerError = caught instanceof Error ? caught.message : String(caught);
  }

  BrowserRemotePinRegistry.prototype.drop = originalDrop;
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  const observed = {
    concurrentError,
    dropsWhileOwnerActive,
    dropsAfterOwnerFinished: [...drops],
    expectedFingerprint: expectedRequest.fingerprint,
    ownerResult,
    ownerError,
    counts,
    transportCalls: transport.calls,
    events,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

"""
    marker = "async function driftDuringAck() {"
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: drift ausente")
    script = script.replace(marker, scenario + marker, 1)

    output_anchor = "console.log(JSON.stringify({\n  drift: await driftDuringAck(),"
    if script.count(output_anchor) != 1:
        raise AssertionError("fixture #204 cambió: salida")
    script = script.replace(
        output_anchor,
        "console.log(JSON.stringify({\n"
        "  ownership: await tickPinOwnership(),\n"
        "  drift: await driftDuringAck(),",
        1,
    )

    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])["ownership"]


class FactoryRunnerBrowserTickOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_rejected_concurrent_tick_cannot_drop_active_tick_pins(self):
        concurrent = self.observed["concurrentError"]
        self.assertEqual(concurrent["name"], "TypeError")
        self.assertIn("ya está en ejecución", concurrent["message"])
        self.assertEqual(self.observed["dropsWhileOwnerActive"], [])
        self.assertEqual(
            self.observed["ownerResult"],
            {"processed": 1, "cursor": None},
        )
        self.assertIsNone(self.observed["ownerError"])
        self.assertEqual(self.observed["transportCalls"], 1)
        self.assertEqual(
            self.observed["events"],
            ["accepted", "started", "completed"],
        )

    def test_active_tick_cleans_only_its_own_pins(self):
        self.assertEqual(
            self.observed["dropsAfterOwnerFinished"],
            [self.observed["expectedFingerprint"]],
        )
        self.assertEqual(
            self.observed["counts"],
            {"ack": 1, "publish": 1, "placement": 1, "request": 1},
        )


if __name__ == "__main__":
    unittest.main()
