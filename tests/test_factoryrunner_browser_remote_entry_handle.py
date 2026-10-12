"""Aceptación del handle in-memory de entry browser remoto (#216)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteEntryHandle } from './src/browser-remote-entry-handle.ts';
import { browserRemoteProfile } from './src/browser-remote-profile.ts';

const profile = browserRemoteProfile({
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});

class MutableTransport {
  calls = 0;
  tags = [];

  async execute(request) {
    this.calls += 1;
    this.tags.push(request.tag);
    return {
      source: 'original',
      calls: this.calls,
      tag: request.tag,
    };
  }
}

function rejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const transport = new MutableTransport();
const originalExecute = transport.execute;
const entry = Object.freeze({ profile, transport });
const handle = browserRemoteEntryHandle(entry);

const exactProfile = handle.profile === profile;
const sameExecuteReference = handle.execute === originalExecute;
const frozen = Object.isFrozen(handle);
const bindingFingerprint = handle.binding_fingerprint;

let hijackCalls = 0;
transport.execute = async function (request) {
  hijackCalls += 1;
  this.tags.push('hijacked:' + request.tag);
  return { source: 'hijacked' };
};

const first = await handle.invoke({ tag: 'first' });
transport.tags.push('external-state');

const tamperedProfileRejected = rejected(() => {
  browserRemoteEntryHandle({
    profile: { ...profile, fingerprint: '0'.repeat(64) },
    transport,
  });
});
const invalidTransportRejected = rejected(() => {
  browserRemoteEntryHandle({ profile, transport: {} });
});
const extraEntryFieldRejected = rejected(() => {
  browserRemoteEntryHandle({ profile, transport, endpoint: 'https://example.test' });
});

// A canonical-looking nested profile must never run any of its seven getters.
const nestedProfileAccessorCases = Object.fromEntries([
  'version', 'authority', 'runner_id', 'location',
  'capability', 'remote_alias', 'fingerprint',
].map((key) => {
  let getterCalls = 0;
  const malicious = { ...profile };
  Object.defineProperty(malicious, key, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return profile[key];
    },
  });
  const unusedTransport = new MutableTransport();
  const refused = rejected(() => browserRemoteEntryHandle({
    profile: malicious,
    transport: unusedTransport,
  }));
  return [key, { refused, getterCalls, transportCalls: unusedTransport.calls }];
}));

// AC-01: own accessor wrappers are rejected without touching their getters.
let profileGetterCalls = 0;
const wrapperProfileRejected = rejected(() => browserRemoteEntryHandle({
  get profile() {
    profileGetterCalls += 1;
    throw new Error('profile getter must not execute');
  },
  transport: new MutableTransport(),
}));
let transportGetterCalls = 0;
const wrapperTransportRejected = rejected(() => browserRemoteEntryHandle({
  profile,
  get transport() {
    transportGetterCalls += 1;
    throw new Error('transport getter must not execute');
  },
}));

// AC-02: neither own nor inherited execute getters may be evaluated.
let ownExecuteGetterCalls = 0;
const ownAccessor = {
  get execute() {
    ownExecuteGetterCalls += 1;
    return async () => ({ source: 'forbidden' });
  },
};
const ownExecuteRejected = rejected(() =>
  browserRemoteEntryHandle({ profile, transport: ownAccessor })
);
let inheritedExecuteGetterCalls = 0;
const inheritedAccessor = Object.create({
  get execute() {
    inheritedExecuteGetterCalls += 1;
    return async () => ({ source: 'forbidden' });
  },
});
const inheritedExecuteRejected = rejected(() =>
  browserRemoteEntryHandle({ profile, transport: inheritedAccessor })
);

// AC-03: class methods are inherited data descriptors; keep this and the
// original transport reference, correct this binding, and one-shot invoke.
class ValidInheritedTransport {
  calls = 0;
  async execute(request) {
    this.calls += 1;
    return { tag: request.tag, calls: this.calls };
  }
}
const validInherited = new ValidInheritedTransport();
const inheritedMethod = Object.getOwnPropertyDescriptor(
  ValidInheritedTransport.prototype, 'execute'
)?.value;
const validHandle = browserRemoteEntryHandle({ profile, transport: validInherited });
const inheritedMethodCaptured = validHandle.execute === inheritedMethod
  && validHandle.profile === profile && Object.isFrozen(validHandle);
const inheritedFirst = await validHandle.invoke({ tag: 'once' });
const inheritedSecondRejected = await validHandle.invoke({ tag: 'again' }).then(
  () => false,
  (error) => error instanceof TypeError,
);
const inheritedOnlyOnce = validInherited.calls === 1;

console.log(JSON.stringify({
  exactProfile,
  sameExecuteReference,
  frozen,
  bindingFingerprint,
  expectedFingerprint: profile.fingerprint,
  first,
  calls: transport.calls,
  tags: transport.tags,
  hijackCalls,
  currentTransportIsHijacked: transport.execute !== originalExecute,
  tamperedProfileRejected,
  invalidTransportRejected,
  extraEntryFieldRejected,
  nestedProfileAccessorCases,
  wrapperProfileRejected,
  wrapperTransportRejected,
  profileGetterCalls,
  transportGetterCalls,
  ownExecuteRejected,
  inheritedExecuteRejected,
  ownExecuteGetterCalls,
  inheritedExecuteGetterCalls,
  inheritedMethodCaptured,
  inheritedFirst,
  inheritedSecondRejected,
  inheritedOnlyOnce,
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


class FactoryRunnerBrowserRemoteEntryHandleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_handle_captures_exact_entry_profile_and_execute_reference(self):
        self.assertTrue(self.observed["exactProfile"])
        self.assertTrue(self.observed["sameExecuteReference"])
        self.assertTrue(self.observed["frozen"])
        self.assertEqual(
            self.observed["bindingFingerprint"],
            self.observed["expectedFingerprint"],
        )
        self.assertTrue(self.observed["tamperedProfileRejected"])
        self.assertTrue(self.observed["invalidTransportRejected"])
        self.assertTrue(self.observed["extraEntryFieldRejected"])

    def test_nested_profile_accessors_rejected_without_getter(self):
        for key, observation in self.observed["nestedProfileAccessorCases"].items():
            with self.subTest(field=key):
                self.assertTrue(observation["refused"])
                self.assertEqual(observation["getterCalls"], 0)
                self.assertEqual(observation["transportCalls"], 0)

    def test_canonical_data_profile_preserves_identity_and_one_shot_invoke(self):
        self.assertTrue(self.observed["exactProfile"])
        self.assertTrue(self.observed["sameExecuteReference"])
        self.assertTrue(self.observed["frozen"])
        self.assertTrue(self.observed["inheritedMethodCaptured"])
        self.assertTrue(self.observed["inheritedSecondRejected"])
        self.assertTrue(self.observed["inheritedOnlyOnce"])
        self.assertEqual(
            self.observed["first"],
            {"source": "original", "calls": 1, "tag": "first"},
        )

    def test_entry_wrapper_accessors_rejected_without_getter(self):
        self.assertTrue(self.observed["wrapperProfileRejected"])
        self.assertTrue(self.observed["wrapperTransportRejected"])
        self.assertEqual(self.observed["profileGetterCalls"], 0)
        self.assertEqual(self.observed["transportGetterCalls"], 0)

    def test_transport_execute_accessors_rejected_without_getter(self):
        self.assertTrue(self.observed["ownExecuteRejected"])
        self.assertTrue(self.observed["inheritedExecuteRejected"])
        self.assertEqual(self.observed["ownExecuteGetterCalls"], 0)
        self.assertEqual(self.observed["inheritedExecuteGetterCalls"], 0)

    def test_data_and_inherited_method_handle_preserve_identity(self):
        self.assertTrue(self.observed["inheritedMethodCaptured"])
        self.assertEqual(self.observed["inheritedFirst"], {"tag": "once", "calls": 1})
        self.assertTrue(self.observed["inheritedSecondRejected"])
        self.assertTrue(self.observed["inheritedOnlyOnce"])
        self.assertTrue(self.observed["sameExecuteReference"])
        self.assertTrue(self.observed["exactProfile"])

    def test_handle_ignores_later_transport_method_swap_and_preserves_internal_state(self):
        self.assertTrue(self.observed["currentTransportIsHijacked"])
        self.assertEqual(self.observed["hijackCalls"], 0)
        self.assertEqual(
            self.observed["first"],
            {"source": "original", "calls": 1, "tag": "first"},
        )
        self.assertEqual(self.observed["calls"], 1)
        self.assertEqual(
            self.observed["tags"],
            ["first", "external-state"],
        )


if __name__ == "__main__":
    unittest.main()
