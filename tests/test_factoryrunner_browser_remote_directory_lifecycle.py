"""Aceptación del lifecycle de rotación del directorio browser remoto (#247)."""
import json, subprocess, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "tests" / "test_factoryrunner_browser_remote_ack_drift.py"


def observe() -> dict[str, object]:
    source = BASE.read_text(encoding="utf-8")
    prefix, suffix = '    script = r"""\n', '"""\n    raw = subprocess.check_output('
    if source.count(prefix) != 1 or source.count(suffix) != 1:
        raise AssertionError("fixture #204 cambió")
    script = source.split(prefix, 1)[1].split(suffix, 1)[0]

    edits = (
        ("const ORDER = '22222222-2222-7222-8222-222222222222';",
         "let ORDER = '22222222-2222-7222-8222-222222222222';"),
        ("const order = {", "let order = {"),
        ("const orderHash = orderFingerprint(order);",
         "let orderHash = orderFingerprint(order);"),
        ("    admission: () => a,\n    plan: () => p,",
         "    admission: () => admission(),\n"
         "    plan: (_currentOrder, currentAdmission) => plan(currentAdmission),"),
        ("""    browser_request: () => {
      counts.request += 1;
      return request;
    },""",
         """    browser_request: (_currentOrder, currentPlan) => {
      counts.request += 1;
      return requestFor(currentPlan);
    },"""),
    )
    for old, new in edits:
        if script.count(old) != 1:
            raise AssertionError(f"fixture #204 cambió: {old[:32]}")
        script = script.replace(old, new, 1)

    scenarios = r"""
async function terminalRecoveryAfterRotation() {
  const root = mkdtempSync(join(tmpdir(), 'fr247-terminal-'));
  const oldTransport = new Transport('old');
  const incompatibleTransport = new Transport('incompatible');
  const directory = new BrowserRemoteDirectory();
  const oldProfile = remoteProfile('browser-primary');
  const incompatibleProfile = browserRemoteProfile({
    version: 1, runner_id: RUNNER, location: 'macos-local',
    capability: 'browser.navigate', remote_alias: 'browser-primary',
  });
  directory.register({ profile: oldProfile, transport: oldTransport });
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  let rotated = false;
  const runtime = configuredSupervisor(root, directory, counts, async () => {
    if (rotated) return;
    directory.rotate('browser-primary', oldProfile.fingerprint, {
      profile: incompatibleProfile, transport: incompatibleTransport,
    });
    rotated = true;
  }, 247);

  const first = await runtime.tick(1);
  let second = null, error = null;
  try { second = await runtime.tick(1); }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  rmSync(root, { recursive: true, force: true });
  return { first, second, error, counts, oldCalls: oldTransport.calls,
    incompatibleCalls: incompatibleTransport.calls, events };
}

async function rotationAcrossTicks() {
  const root = mkdtempSync(join(tmpdir(), 'fr247-rotation-'));
  const oldTransport = new Transport('old');
  const newTransport = new Transport('new');
  const directory = new BrowserRemoteDirectory();
  const profile = remoteProfile('browser-primary');
  directory.register({ profile, transport: oldTransport });
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  let rotated = false;
  const runtime = configuredSupervisor(root, directory, counts, async () => {
    if (rotated) return;
    directory.rotate('browser-primary', profile.fingerprint, {
      profile, transport: newTransport,
    });
    rotated = true;
  }, 347);

  const first = await runtime.tick(1);
  ORDER = '22222222-2222-7222-8222-222222222248';
  order = { ...order, order_id: ORDER, work_item_id: 'factoryrunner:work:247-next',
    instruction_ref: 'controlbot:instruction:247-next' };
  orderHash = orderFingerprint(order);
  const second = await runtime.tick(1);
  rmSync(root, { recursive: true, force: true });
  return { first, second, counts, oldCalls: oldTransport.calls,
    newCalls: newTransport.calls,
    oldUrl: oldTransport.requests[0]?.command?.url ?? null,
    newUrl: newTransport.requests[0]?.command?.url ?? null };
}
"""
    marker = "async function recovery() {"
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: recovery")
    script = script.replace(marker, scenarios + marker, 1)

    output = "console.log(JSON.stringify({\n  drift: await driftDuringAck(),"
    if script.count(output) != 1:
        raise AssertionError("fixture #204 cambió: output")
    script = script.replace(
        output,
        "console.log(JSON.stringify({"
        "\n  terminal: await terminalRecoveryAfterRotation(),"
        "\n  rotation: await rotationAcrossTicks(),"
        "\n  drift: await driftDuringAck(),",
        1,
    )
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT, text=True, stderr=subprocess.STDOUT, timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteDirectoryLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_rotation_does_not_switch_pinned_handle_inside_tick_and_next_tick_uses_current_entry(self):
        item = self.observed["rotation"]
        self.assertEqual(item["first"], {"processed": 1, "cursor": None})
        self.assertEqual(item["second"], {"processed": 1, "cursor": None})
        self.assertEqual(item["counts"], {"ack": 2, "publish": 2, "placement": 2, "request": 2})
        self.assertEqual((item["oldCalls"], item["newCalls"]), (1, 1))
        self.assertEqual(item["oldUrl"], "https://example.com/ack-drift-204")
        self.assertEqual(item["newUrl"], "https://example.com/ack-drift-204")

    def test_terminal_recovery_after_rotation_revalidates_without_ack_or_transport_replay(self):
        item = self.observed["terminal"]
        self.assertEqual(item["first"], {"processed": 1, "cursor": None})
        self.assertIsNone(item["second"])
        self.assertIsNotNone(item["error"])
        self.assertEqual(item["counts"], {"ack": 1, "publish": 1, "placement": 2, "request": 2})
        self.assertEqual((item["oldCalls"], item["incompatibleCalls"]), (1, 0))
        self.assertEqual(item["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
