"""Aceptación del directorio browser remoto in-memory (#173)."""
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

const baseInput = {
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
};

let transportCalls = 0;
const transport = {
  async execute() {
    transportCalls += 1;
    throw new Error('transport must not run during directory operations');
  },
};

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const profile = browserRemoteProfile(baseInput);
const directory = new BrowserRemoteDirectory();
const registered = directory.register({ profile, transport });
const found = directory.lookup('browser-primary');
const missing = directory.lookup('browser-secondary');
const entries = directory.entries();

const duplicateRejected = rejected(() => {
  directory.register({ profile, transport });
});

const rejectedTransport = {
  async execute() {
    transportCalls += 1;
    throw new Error('rejected duplicate transport must not execute');
  },
};
const descriptorBefore = Object.getOwnPropertyDescriptor(rejectedTransport, 'execute');
const duplicateWithNewTransportRejected = rejected(() => {
  directory.register({ profile, transport: rejectedTransport });
});
const descriptorAfter = Object.getOwnPropertyDescriptor(rejectedTransport, 'execute');
const rejectedTransportUnchanged = descriptorBefore !== undefined
  && descriptorAfter !== undefined
  && descriptorBefore.value === descriptorAfter.value
  && descriptorBefore.writable === true
  && descriptorAfter.writable === true
  && descriptorBefore.configurable === true
  && descriptorAfter.configurable === true
  && descriptorBefore.enumerable === descriptorAfter.enumerable;
const entryUnchangedAfterDuplicate = directory.size === 1
  && directory.lookup('browser-primary') === registered;
const acceptedTransportSealed = Object.getOwnPropertyDescriptor(transport, 'execute')?.writable === false
  && Object.getOwnPropertyDescriptor(transport, 'execute')?.configurable === false;

const tamperedFingerprintRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, fingerprint: '0'.repeat(64) },
    transport,
  });
});

const tamperedAuthorityRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, authority: 'expanded' },
    transport,
  });
});

const extraProfileFieldRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({
    profile: { ...profile, endpoint: 'https://remote.example.test' },
    transport,
  });
});

const invalidTransportRejected = rejected(() => {
  const candidate = new BrowserRemoteDirectory();
  candidate.register({ profile, transport: {} });
});

const invalidLookupAliasRejected = rejected(() => {
  directory.lookup('https://remote.example.test');
});


const secondaryProfile = browserRemoteProfile({ ...baseInput, remote_alias: 'browser-secondary' });
let ownGetterReads = 0;
const ownAccessorTransport = {
  get execute() {
    ownGetterReads += 1;
    throw new Error('execute getter must not be invoked');
  },
};
const ownAccessorBefore = Object.getOwnPropertyDescriptor(ownAccessorTransport, 'execute');
const ownAccessorRegistrationRejected = rejected(() => {
  directory.register({ profile: secondaryProfile, transport: ownAccessorTransport });
});
const ownAccessorAfter = Object.getOwnPropertyDescriptor(ownAccessorTransport, 'execute');
const ownAccessorUnchanged = ownAccessorBefore?.get === ownAccessorAfter?.get
  && ownAccessorBefore?.configurable === ownAccessorAfter?.configurable
  && !Object.hasOwn(ownAccessorAfter ?? {}, 'value');

let inheritedGetterReads = 0;
const inheritedAccessorPrototype = {
  get execute() {
    inheritedGetterReads += 1;
    throw new Error('inherited execute getter must not be invoked');
  },
};
const inheritedAccessorTransport = Object.create(inheritedAccessorPrototype);
const inheritedAccessorRegistrationRejected = rejected(() => {
  directory.register({ profile: secondaryProfile, transport: inheritedAccessorTransport });
});
const inheritedAccessorUnchanged = !Object.hasOwn(inheritedAccessorTransport, 'execute')
  && Object.getOwnPropertyDescriptor(inheritedAccessorPrototype, 'execute')?.get !== undefined;

const ownAccessorRotationRejected = rejected(() => {
  directory.rotate('browser-primary', profile.fingerprint, { profile, transport: ownAccessorTransport });
});
const inheritedAccessorRotationRejected = rejected(() => {
  directory.rotate('browser-primary', profile.fingerprint, { profile, transport: inheritedAccessorTransport });
});
const entryPreservedAfterAccessorRejections = directory.lookup('browser-primary') === registered
  && directory.size === 1 && directory.lookup('browser-secondary') === null;

let inheritedMethodCalls = 0;
class ClassMethodTransport {
  async execute() {
    inheritedMethodCalls += 1;
    throw new Error('method must not execute during registration');
  }
}
const inheritedMethodTransport = new ClassMethodTransport();
const originalMethod = Object.getOwnPropertyDescriptor(ClassMethodTransport.prototype, 'execute')?.value;
const inheritedMethodDirectory = new BrowserRemoteDirectory();
const inheritedMethodEntry = inheritedMethodDirectory.register({
  profile: secondaryProfile, transport: inheritedMethodTransport,
});
const inheritedMethodSealed = inheritedMethodEntry.transport === inheritedMethodTransport
  && Object.getOwnPropertyDescriptor(inheritedMethodTransport, 'execute')?.value === originalMethod
  && Object.getOwnPropertyDescriptor(inheritedMethodTransport, 'execute')?.writable === false
  && Object.getOwnPropertyDescriptor(inheritedMethodTransport, 'execute')?.configurable === false
  && inheritedMethodCalls === 0;

console.log(JSON.stringify({
  registeredAlias: registered.profile.remote_alias,
  foundAlias: found?.profile.remote_alias ?? null,
  foundUsesSameTransport: found?.transport === transport,
  missing,
  entryCount: entries.length,
  entriesFrozen: Object.isFrozen(entries),
  entryFrozen: Object.isFrozen(registered),
  profileFrozen: Object.isFrozen(registered.profile),
  transportCalls,
  duplicateRejected,
  duplicateWithNewTransportRejected,
  rejectedTransportUnchanged,
  entryUnchangedAfterDuplicate,
  acceptedTransportSealed,
  ownAccessorRegistrationRejected,
  inheritedAccessorRegistrationRejected,
  ownAccessorUnchanged,
  inheritedAccessorUnchanged,
  ownGetterReads,
  inheritedGetterReads,
  ownAccessorRotationRejected,
  inheritedAccessorRotationRejected,
  entryPreservedAfterAccessorRejections,
  inheritedMethodSealed,
  inheritedMethodCalls,
  tamperedFingerprintRejected,
  tamperedAuthorityRejected,
  extraProfileFieldRejected,
  invalidTransportRejected,
  invalidLookupAliasRejected,
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


class FactoryRunnerBrowserRemoteDirectoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_directory_registers_canonical_profiles_by_opaque_alias_without_transport_calls(self):
        self.assertEqual(self.observed["registeredAlias"], "browser-primary")
        self.assertEqual(self.observed["foundAlias"], "browser-primary")
        self.assertTrue(self.observed["foundUsesSameTransport"])
        self.assertIsNone(self.observed["missing"])
        self.assertEqual(self.observed["entryCount"], 1)
        self.assertTrue(self.observed["entriesFrozen"])
        self.assertTrue(self.observed["entryFrozen"])
        self.assertTrue(self.observed["profileFrozen"])
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_duplicate_registration_does_not_seal_rejected_transport(self):
        self.assertTrue(self.observed["duplicateWithNewTransportRejected"])
        self.assertTrue(self.observed["rejectedTransportUnchanged"])
        self.assertTrue(self.observed["entryUnchangedAfterDuplicate"])
        self.assertTrue(self.observed["acceptedTransportSealed"])
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_accessor_execute_is_denied_without_getter_invocation(self):
        self.assertTrue(self.observed["ownAccessorRegistrationRejected"])
        self.assertTrue(self.observed["inheritedAccessorRegistrationRejected"])
        self.assertTrue(self.observed["ownAccessorUnchanged"])
        self.assertTrue(self.observed["inheritedAccessorUnchanged"])
        self.assertEqual(self.observed["ownGetterReads"], 0)
        self.assertEqual(self.observed["inheritedGetterReads"], 0)
        self.assertTrue(self.observed["entryPreservedAfterAccessorRejections"])
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_rotate_accessor_execute_keeps_original_entry(self):
        self.assertTrue(self.observed["ownAccessorRotationRejected"])
        self.assertTrue(self.observed["inheritedAccessorRotationRejected"])
        self.assertTrue(self.observed["entryPreservedAfterAccessorRejections"])
        self.assertEqual(self.observed["ownGetterReads"], 0)
        self.assertEqual(self.observed["inheritedGetterReads"], 0)
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_data_and_inherited_method_transports_still_seal(self):
        self.assertTrue(self.observed["acceptedTransportSealed"])
        self.assertTrue(self.observed["inheritedMethodSealed"])
        self.assertEqual(self.observed["inheritedMethodCalls"], 0)
        self.assertEqual(self.observed["transportCalls"], 0)

    def test_duplicate_or_tampered_profiles_fail_closed(self):
        self.assertTrue(self.observed["duplicateRejected"])
        self.assertTrue(self.observed["tamperedFingerprintRejected"])
        self.assertTrue(self.observed["tamperedAuthorityRejected"])
        self.assertTrue(self.observed["extraProfileFieldRejected"])
        self.assertTrue(self.observed["invalidTransportRejected"])
        self.assertTrue(self.observed["invalidLookupAliasRejected"])
        self.assertEqual(self.observed["transportCalls"], 0)


if __name__ == "__main__":
    unittest.main()
