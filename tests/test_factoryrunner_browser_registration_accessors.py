"""Offline acceptance of browser registration data descriptors (FactoryRunner #556)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { BrowserRemoteDirectory } from './src/browser-remote-directory.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const base = {
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
};
const profile = browserRemoteProfile(base);
let getterCalls = 0;
let executeCalls = 0;
function transport() {
  return { async execute() { executeCalls += 1; throw new Error('No dispatch during registry operations'); } };
}
function denied(fn) {
  try { fn(); return false; } catch (error) { return error instanceof TypeError; }
}
function accessorInput(name, profileValue, transportValue) {
  const candidate = { profile: profileValue, transport: transportValue };
  Object.defineProperty(candidate, name, {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; throw new Error('Accessor must not execute: ' + name); },
  });
  return candidate;
}
function isMutableExecute(input) {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'execute');
  return descriptor?.writable === true && descriptor?.configurable === true;
}
const empty = new BrowserRemoteDirectory();
const rejectedProfileTransport = transport();
const rejectedTransportTransport = transport();
const ownProfileRejected = denied(() => empty.register(accessorInput('profile', profile, rejectedProfileTransport)));
const ownTransportRejected = denied(() => empty.register(accessorInput('transport', profile, rejectedTransportTransport)));
const emptyAfterRejections = empty.size === 0;
const rejectedRegistrationTransportsUnsealed = isMutableExecute(rejectedProfileTransport)
  && isMutableExecute(rejectedTransportTransport);

const directory = new BrowserRemoteDirectory();
const originalTransport = transport();
const initial = directory.register({ profile, transport: originalTransport });
const rejectedRotateProfileTransport = transport();
const rejectedRotateTransportTransport = transport();
const rotateProfileRejected = denied(() => directory.rotate(
  'browser-primary', profile.fingerprint,
  accessorInput('profile', profile, rejectedRotateProfileTransport),
));
const rotateTransportRejected = denied(() => directory.rotate(
  'browser-primary', profile.fingerprint,
  accessorInput('transport', profile, rejectedRotateTransportTransport),
));
const rotatePreservesEntry = directory.lookup('browser-primary') === initial
  && directory.size === 1 && initial.transport === originalTransport;
const rejectedRotationTransportsUnsealed = isMutableExecute(rejectedRotateProfileTransport)
  && isMutableExecute(rejectedRotateTransportTransport);

const valid = new BrowserRemoteDirectory();
const firstTransport = transport();
const first = valid.register({ profile, transport: firstTransport });
const secondTransport = transport();
const rotated = valid.rotate('browser-primary', profile.fingerprint, {
  profile, transport: secondTransport,
});
const dataAccepted = first.transport === firstTransport && first.profile.fingerprint === profile.fingerprint;
const validRotationPreservesReferences = rotated.transport === secondTransport
  && rotated.profile.fingerprint === profile.fingerprint && valid.lookup('browser-primary') === rotated
  && valid.size === 1 && first !== rotated;
const executeSealed = [firstTransport, secondTransport].every((item) => {
  const descriptor = Object.getOwnPropertyDescriptor(item, 'execute');
  return descriptor?.writable === false && descriptor?.configurable === false;
});
console.log(JSON.stringify({
  ownProfileRejected, ownTransportRejected, emptyAfterRejections,
  rejectedRegistrationTransportsUnsealed,
  rotateProfileRejected, rotateTransportRejected, rotatePreservesEntry,
  rejectedRotationTransportsUnsealed,
  dataAccepted, validRotationPreservesReferences, executeSealed,
  getterCalls, executeCalls,
}));
"""
    output = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(output.strip().splitlines()[-1])


class FactoryRunnerBrowserRegistrationAccessorsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_register_rejects_own_accessors_before_invocation(self):
        self.assertTrue(self.observed["ownProfileRejected"])
        self.assertTrue(self.observed["ownTransportRejected"])
        self.assertTrue(self.observed["emptyAfterRejections"])
        self.assertTrue(self.observed["rejectedRegistrationTransportsUnsealed"])
        self.assertEqual(self.observed["getterCalls"], 0)
        self.assertEqual(self.observed["executeCalls"], 0)

    def test_rotate_rejects_own_accessors_and_preserves_entry(self):
        self.assertTrue(self.observed["rotateProfileRejected"])
        self.assertTrue(self.observed["rotateTransportRejected"])
        self.assertTrue(self.observed["rotatePreservesEntry"])
        self.assertTrue(self.observed["rejectedRotationTransportsUnsealed"])
        self.assertEqual(self.observed["getterCalls"], 0)
        self.assertEqual(self.observed["executeCalls"], 0)

    def test_plain_data_registration_and_rotation_stay_compatible(self):
        self.assertTrue(self.observed["dataAccepted"])
        self.assertTrue(self.observed["validRotationPreservesReferences"])
        self.assertTrue(self.observed["executeSealed"])
        self.assertEqual(self.observed["getterCalls"], 0)
        self.assertEqual(self.observed["executeCalls"], 0)


if __name__ == "__main__":
    unittest.main()
