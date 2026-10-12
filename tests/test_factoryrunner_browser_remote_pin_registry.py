"""Aceptación del registry atómico de pins browser remotos (#230)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteEntryHandle } from './src/browser-remote-entry-handle.ts';
import { BrowserRemotePinRegistry } from './src/browser-remote-pin-registry.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const REQUEST = 'a'.repeat(64);

class Transport {
  async execute(request) {
    return {
      version: 1,
      authority: 'unchanged',
      request_fingerprint: request.request_fingerprint,
      status: 'ok',
      ref: 'browserref:pin-registry-0230',
    };
  }
}

const directory = new BrowserRemoteDirectory();
const entry = directory.register({
  profile: browserRemoteProfile({
    version: 1,
    runner_id: '11111111-1111-7111-8111-111111111111',
    location: 'hostinger-shared',
    capability: 'browser.navigate',
    remote_alias: 'browser-primary',
  }),
  transport: new Transport(),
});
const handle = browserRemoteEntryHandle(entry);
const directoryEntries = directory.entries;

const atomic = new BrowserRemotePinRegistry();
const pinned = atomic.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});
const peek = atomic.peek(REQUEST);
const sizeBeforeTake = atomic.size;
const taken = atomic.take(REQUEST);
const sizeAfterTake = atomic.size;
const secondTake = atomic.take(REQUEST);

const drift = new BrowserRemotePinRegistry();
const original = drift.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});
const idempotent = drift.pin(REQUEST, {
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: directoryEntries,
});

function rejects(candidate) {
  try {
    drift.pin(REQUEST, candidate);
    return false;
  } catch {
    return true;
  }
}

const bindingDrift = rejects({
  binding_fingerprint: 'f'.repeat(64),
  handle,
  directory_entries: directoryEntries,
});
const handleDrift = rejects({
  binding_fingerprint: handle.binding_fingerprint,
  handle: browserRemoteEntryHandle(entry),
  directory_entries: directoryEntries,
});
const directoryDrift = rejects({
  binding_fingerprint: handle.binding_fingerprint,
  handle,
  directory_entries: () => directory.entries(),
});
const sizeBeforeDrop = drift.size;
drift.drop(REQUEST);
drift.drop(REQUEST);

console.log(JSON.stringify({
  atomic: {
    pinnedIsPeek: pinned === peek,
    pinnedIsTaken: pinned === taken,
    handleExact: taken?.handle === handle,
    directoryExact: taken?.directory_entries === directoryEntries,
    sizeBeforeTake,
    sizeAfterTake,
    secondTake,
  },
  drift: {
    idempotentExact: original === idempotent,
    bindingDrift,
    handleDrift,
    directoryDrift,
    sizeBeforeDrop,
    sizeAfterDrop: drift.size,
    peekAfterDrop: drift.peek(REQUEST),
  },
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


def observe_accessor_cases() -> dict[str, object]:
    script = r"""
import { BrowserRemotePinRegistry } from './src/browser-remote-pin-registry.ts';
const REQUEST = 'a'.repeat(64);
const BINDING = 'b'.repeat(64);
const validHandle = { invoke() {}, execute() {} };
const validEntries = () => [];
const validInput = () => ({
  binding_fingerprint: BINDING,
  handle: validHandle,
  directory_entries: validEntries,
});
function attempt(targetKind, key, inherited, preexisting) {
  const registry = new BrowserRemotePinRegistry();
  const original = preexisting ? registry.pin(REQUEST, validInput()) : null;
  const input = validInput();
  let target = input;
  if (targetKind === 'handle') {
    target = { ...validHandle };
    input.handle = target;
  }
  const originalValue = target[key];
  let getterCalls = 0;
  if (inherited) {
    delete target[key];
    const parent = {};
    Object.defineProperty(parent, key, {
      get() { getterCalls += 1; return originalValue; },
    });
    Object.setPrototypeOf(target, parent);
  } else {
    Object.defineProperty(target, key, {
      get() { getterCalls += 1; return originalValue; },
    });
  }
  let rejected = false;
  try { registry.pin(REQUEST, input); } catch (error) {
    rejected = error instanceof TypeError;
  }
  return {
    key,
    inherited,
    rejected,
    getterCalls,
    unchanged: registry.size === (preexisting ? 1 : 0)
      && registry.peek(REQUEST) === original,
  };
}
const inputCases = ['binding_fingerprint', 'handle', 'directory_entries']
  .flatMap(key => [false, true].map(inherited => attempt('input', key, inherited, false)));
const handleCases = ['invoke', 'execute']
  .flatMap(key => [false, true].map(inherited => attempt('handle', key, inherited, true)));
class MethodHandle { invoke() {} execute() {} }
const accepted = new BrowserRemotePinRegistry();
const handle = new MethodHandle();
const directoryEntries = () => [];
const candidate = { binding_fingerprint: BINDING, handle, directory_entries: directoryEntries };
const pinned = accepted.pin(REQUEST, candidate);
const idempotent = accepted.pin(REQUEST, candidate) === pinned;
const identity = pinned.handle === handle && pinned.directory_entries === directoryEntries;
const atomic = accepted.take(REQUEST) === pinned && accepted.take(REQUEST) === null;
accepted.drop(REQUEST);
console.log(JSON.stringify({
  inputCases,
  handleCases,
  valid: { idempotent, identity, atomic, empty: accepted.size === 0 },
}));
"""
    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])

class FactoryRunnerBrowserRemotePinRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()
        cls.accessor_observed = observe_accessor_cases()

    def test_registry_take_is_atomic_and_second_take_returns_no_handle(self):
        self.assertEqual(
            self.observed["atomic"],
            {
                "pinnedIsPeek": True,
                "pinnedIsTaken": True,
                "handleExact": True,
                "directoryExact": True,
                "sizeBeforeTake": 1,
                "sizeAfterTake": 0,
                "secondTake": None,
            },
        )

    def test_registry_rejects_drift_on_existing_fingerprint_and_drop_is_idempotent(self):
        self.assertEqual(
            self.observed["drift"],
            {
                "idempotentExact": True,
                "bindingDrift": True,
                "handleDrift": True,
                "directoryDrift": True,
                "sizeBeforeDrop": 1,
                "sizeAfterDrop": 0,
                "peekAfterDrop": None,
            },
        )


    def test_pin_rejects_input_accessors_without_invoking_getters(self):
        cases = self.accessor_observed["inputCases"]
        self.assertEqual(len(cases), 6)
        for case in cases:
            with self.subTest(key=case["key"], inherited=case["inherited"]):
                self.assertTrue(case["rejected"])
                self.assertEqual(case["getterCalls"], 0)
                self.assertTrue(case["unchanged"])

    def test_pin_rejects_accessor_handle_methods_without_invocation(self):
        cases = self.accessor_observed["handleCases"]
        self.assertEqual(len(cases), 4)
        for case in cases:
            with self.subTest(key=case["key"], inherited=case["inherited"]):
                self.assertTrue(case["rejected"])
                self.assertEqual(case["getterCalls"], 0)
                self.assertTrue(case["unchanged"])

    def test_data_handle_pin_remains_atomic_and_idempotent(self):
        self.assertEqual(self.accessor_observed["valid"], {
            "idempotent": True,
            "identity": True,
            "atomic": True,
            "empty": True,
        })

if __name__ == "__main__":
    unittest.main()
