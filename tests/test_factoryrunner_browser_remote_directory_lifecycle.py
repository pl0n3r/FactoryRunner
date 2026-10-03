"""Aceptación del lifecycle de rotación del directorio browser remoto (#247)."""
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

    scenarios = r"""
function lifecycleOrder(orderId, workItemId, instructionRef) {
  return {
    ...order,
    order_id: orderId,
    work_item_id: workItemId,
    instruction_ref: instructionRef,
  };
}

function admissionFor(currentOrder) {
  const currentOrderHash = orderFingerprint(currentOrder);
  const core = {
    version: 1,
    decision: 'ALLOW',
    authority: 'unchanged',
    runner_id: RUNNER,
    order_id: currentOrder.order_id,
    work_item_id: currentOrder.work_item_id,
    observed_at: NOW,
    order_fingerprint: currentOrderHash,
    manifest_fingerprint: manifest.fingerprint,
    resource_fingerprint: stableSha256(resource),
    reasons: ['admission_evidence_coherent'],
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function planFor(currentOrder, currentAdmission) {
  const core = {
    version: 1,
    authority: 'unchanged',
    runner_id: RUNNER,
    order_id: currentOrder.order_id,
    work_item_id: currentOrder.work_item_id,
    capability: currentOrder.capability,
    order_fingerprint: currentAdmission.order_fingerprint,
    admission_fingerprint: currentAdmission.fingerprint,
    adapter_id: 'browser-execution',
    manifest_fingerprint: currentAdmission.manifest_fingerprint,
    resource_fingerprint: currentAdmission.resource_fingerprint,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function requestForOrder(currentOrder, currentPlan, suffix) {
  const step = browserPlanStep(currentOrder, currentPlan, {
    version: 1,
    adapter_id: 'browser-execution',
    capability: 'browser.navigate',
    payload: { url: `https://example.com/${suffix}` },
  });
  return browserLoopRequest(currentOrder, currentPlan, {
    version: 1,
    browser_kind: 'step',
    browser: step,
  });
}

async function rotationAcrossTicks() {
  const root = mkdtempSync(join(tmpdir(), 'fr247-rotation-ticks-'));
  const firstTransport = new Transport('rotation-old');
  const rotatedTransport = new Transport('rotation-new');
  const directory = new BrowserRemoteDirectory();
  const profile = remoteProfile('browser-primary');
  directory.register({ profile, transport: firstTransport });

  const firstOrder = lifecycleOrder(
    '22222222-2222-7222-8222-222222222247',
    'factoryrunner:work:247-a',
    'controlbot:instruction:247-a',
  );
  const secondOrder = lifecycleOrder(
    '22222222-2222-7222-8222-222222222248',
    'factoryrunner:work:247-b',
    'controlbot:instruction:247-b',
  );
  const orders = [firstOrder, secondOrder];
  let pollIndex = 0;
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };

  const runtime = createBrowserRemoteSupervisor({
    client: {
      async poll() {
        const current = orders[Math.min(pollIndex, orders.length - 1)];
        pollIndex += 1;
        return {
          version: 1,
          cursor: null,
          orders: [{ ...current, fingerprint: orderFingerprint(current) }],
        };
      },
      validatedOrder(orderId) {
        const current = orders.find((candidate) => candidate.order_id === orderId);
        if (current === undefined) throw new TypeError('unknown order');
        return current;
      },
      async ack() {
        counts.ack += 1;
        if (counts.ack === 1) {
          directory.rotate(
            'browser-primary',
            profile.fingerprint,
            { profile, transport: rotatedTransport },
          );
        }
      },
      async publishEvents() { counts.publish += 1; },
      async publishHeartbeat() {},
    },
    journal: new DurableJournal(join(root, 'journal.ndjson')),
    outbox: new DurableOutbox(join(root, 'outbox.ndjson')),
    registry: registry(),
    identity,
    directory,
    allowed_origins: ['https://example.com'],
    admission: (currentOrder) => admissionFor(currentOrder),
    plan: (currentOrder, currentAdmission) => planFor(currentOrder, currentAdmission),
    placement_profile: () => {
      counts.placement += 1;
      return placementProfile();
    },
    browser_request: (currentOrder, currentPlan) => {
      counts.request += 1;
      return requestForOrder(
        currentOrder,
        currentPlan,
        currentOrder.order_id === firstOrder.order_id ? 'lifecycle-old' : 'lifecycle-new',
      );
    },
    now: () => NOW,
    event_id: ids(247),
  });

  const first = await runtime.tick(1);
  const second = await runtime.tick(1);
  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => ({
      order_id: event.order_id,
      state: event.state,
    }));

  const observed = {
    first,
    second,
    counts,
    firstTransportCalls: firstTransport.calls,
    rotatedTransportCalls: rotatedTransport.calls,
    firstTransportUrl: firstTransport.requests[0]?.command?.url ?? null,
    rotatedTransportUrl: rotatedTransport.requests[0]?.command?.url ?? null,
    firstOrder: firstOrder.order_id,
    secondOrder: secondOrder.order_id,
    events,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

async function terminalRecoveryAfterIncompatibleRotation() {
  const root = mkdtempSync(join(tmpdir(), 'fr247-terminal-rotation-'));
  const firstTransport = new Transport('terminal-old');
  const incompatibleTransport = new Transport('terminal-incompatible');
  const directory = new BrowserRemoteDirectory();
  const profile = remoteProfile('browser-primary');
  const incompatibleProfile = browserRemoteProfile({
    version: 1,
    runner_id: RUNNER,
    location: 'macos-local',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
  });
  directory.register({ profile, transport: firstTransport });

  let rotated = false;
  const counts = { ack: 0, publish: 0, placement: 0, request: 0 };
  const runtime = configuredSupervisor(
    root,
    directory,
    counts,
    async () => {
      if (rotated) return;
      directory.rotate(
        'browser-primary',
        profile.fingerprint,
        { profile: incompatibleProfile, transport: incompatibleTransport },
      );
      rotated = true;
    },
    347,
  );

  const first = await runtime.tick(1);
  let second = null;
  let secondError = null;
  try {
    second = await runtime.tick(1);
  } catch (caught) {
    secondError = caught instanceof Error ? caught.message : String(caught);
  }

  const events = new DurableJournal(join(root, 'journal.ndjson'))
    .recover().events.map((event) => event.state);
  const observed = {
    first,
    second,
    secondError,
    counts,
    firstTransportCalls: firstTransport.calls,
    incompatibleTransportCalls: incompatibleTransport.calls,
    events,
  };
  rmSync(root, { recursive: true, force: true });
  return observed;
}

"""
    marker = "async function recovery() {"
    if script.count(marker) != 1:
        raise AssertionError("fixture #204 cambió: recovery ausente")
    script = script.replace(marker, scenarios + marker, 1)

    output_marker = "console.log(JSON.stringify({\n  drift: await driftDuringAck(),"
    if script.count(output_marker) != 1:
        raise AssertionError("fixture #204 cambió: salida ausente")
    script = script.replace(
        output_marker,
        "console.log(JSON.stringify({"
        "\n  rotationAcrossTicks: await rotationAcrossTicks(),"
        "\n  terminalRecoveryAfterIncompatibleRotation: "
        "await terminalRecoveryAfterIncompatibleRotation(),"
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


class FactoryRunnerBrowserRemoteDirectoryLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_rotation_does_not_switch_pinned_handle_inside_tick_and_next_tick_uses_current_entry(self):
        item = self.observed["rotationAcrossTicks"]
        self.assertEqual(item["first"], {"processed": 1, "cursor": None})
        self.assertEqual(item["second"], {"processed": 1, "cursor": None})
        self.assertEqual(
            item["counts"],
            {"ack": 2, "publish": 2, "placement": 2, "request": 2},
        )
        self.assertEqual(item["firstTransportCalls"], 1)
        self.assertEqual(item["rotatedTransportCalls"], 1)
        self.assertEqual(item["firstTransportUrl"], "https://example.com/lifecycle-old")
        self.assertEqual(item["rotatedTransportUrl"], "https://example.com/lifecycle-new")
        self.assertEqual(
            [event["state"] for event in item["events"]],
            ["accepted", "started", "completed"] * 2,
        )

    def test_terminal_recovery_after_rotation_revalidates_without_ack_or_transport_replay(self):
        item = self.observed["terminalRecoveryAfterIncompatibleRotation"]
        self.assertEqual(item["first"], {"processed": 1, "cursor": None})
        self.assertIsNone(item["second"])
        self.assertIsNotNone(item["secondError"])
        self.assertEqual(
            item["counts"],
            {"ack": 1, "publish": 1, "placement": 2, "request": 2},
        )
        self.assertEqual(item["firstTransportCalls"], 1)
        self.assertEqual(item["incompatibleTransportCalls"], 0)
        self.assertEqual(item["events"], ["accepted", "started", "completed"])


if __name__ == "__main__":
    unittest.main()
