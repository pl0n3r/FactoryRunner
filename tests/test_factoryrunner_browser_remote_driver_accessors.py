"""Regresiones del transporte browser remoto con accessors (#565)."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteProfile } from './src/browser-remote-profile.ts';
import { BrowserRemoteDriver } from './src/browser-remote-driver.ts';

const profile = browserRemoteProfile({
  version: 1,
  runner_id: '11111111-1111-7111-8111-111111111111',
  location: 'hostinger-shared',
  capability: 'browser.navigate',
  remote_alias: 'browser-primary',
});

const command = {
  kind: 'navigate',
  session_key: 'browsersession:' + 'a'.repeat(64),
  url: 'https://example.com/driver-accessor',
};
const response = (request) => ({
  version: 1,
  authority: 'unchanged',
  request_fingerprint: request.request_fingerprint,
  status: 'ok',
  ref: 'browserref:driver-accessor',
});
function rejectsConstructor(transport) {
  try {
    new BrowserRemoteDriver(profile, transport);
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

let ownGetterCalls = 0;
const ownGetter = Object.defineProperty({}, 'execute', {
  get() {
    ownGetterCalls++;
    return async (request) => response(request);
  },
});
const ownGetterRejected = rejectsConstructor(ownGetter);

let inheritedGetterCalls = 0;
const inheritedPrototype = Object.defineProperty({}, 'execute', {
  get() {
    inheritedGetterCalls++;
    return async (request) => response(request);
  },
});
const inheritedGetterRejected = rejectsConstructor(Object.create(inheritedPrototype));
const missingRejected = rejectsConstructor(Object.create(null));
const nonCallableRejected = rejectsConstructor({ execute: 23 });

const transport = {
  calls: 0,
  lastRequest: null,
  async execute(request) {
    this.calls += 1;
    this.lastRequest = request;
    return response(request);
  },
};
const driver = new BrowserRemoteDriver(profile, transport);
let replacementGetterCalls = 0;
Object.defineProperty(transport, 'execute', {
  configurable: true,
  get() {
    replacementGetterCalls++;
    return async () => {
      throw new Error('Un getter posterior no debe usarse');
    };
  },
});
const stableResult = await driver.execute(command);

class InheritedTransport {
  calls = 0;
  lastRequest = null;
  async execute(request) {
    this.calls++;
    this.lastRequest = request;
    return response(request);
  }
}
const inheritedTransport = new InheritedTransport();
const inheritedResult = await new BrowserRemoteDriver(profile, inheritedTransport).execute(command);
const ownTransport = {
  calls: 0,
  lastRequest: null,
  async execute(request) {
    this.calls++;
    this.lastRequest = request;
    return response(request);
  },
};
const ownResult = await new BrowserRemoteDriver(profile, ownTransport).execute(command);

console.log(JSON.stringify({
  ownGetterRejected,
  inheritedGetterRejected,
  ownGetterCalls,
  inheritedGetterCalls,
  missingRejected,
  nonCallableRejected,
  replacementGetterCalls,
  stableResult,
  stableCalls: transport.calls,
  stableRequest: transport.lastRequest,
  ownResult,
  ownCalls: ownTransport.calls,
  ownRequest: ownTransport.lastRequest,
  inheritedResult,
  inheritedCalls: inheritedTransport.calls,
  inheritedRequest: inheritedTransport.lastRequest,
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


class FactoryRunnerBrowserRemoteDriverAccessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_constructor_rejects_own_and_inherited_execute_getters(self):
        self.assertTrue(self.observed["ownGetterRejected"])
        self.assertTrue(self.observed["inheritedGetterRejected"])
        self.assertEqual(self.observed["ownGetterCalls"], 0)
        self.assertEqual(self.observed["inheritedGetterCalls"], 0)
        self.assertTrue(self.observed["missingRejected"])
        self.assertTrue(self.observed["nonCallableRejected"])

    def test_driver_captures_exact_method_without_post_construction_getter(self):
        self.assertEqual(self.observed["replacementGetterCalls"], 0)
        self.assertEqual(self.observed["stableCalls"], 1)
        self.assertEqual(
            self.observed["stableResult"],
            {"status": "ok", "ref": "browserref:driver-accessor"},
        )
        request = self.observed["stableRequest"]
        self.assertEqual(request["authority"], "unchanged")
        self.assertRegex(request["request_fingerprint"], r"^[0-9a-f]{64}$")

    def test_data_and_inherited_methods_preserve_this_and_driver_contracts(self):
        for name in ("own", "inherited"):
            with self.subTest(name=name):
                self.assertEqual(self.observed[name + "Calls"], 1)
                self.assertEqual(
                    self.observed[name + "Result"],
                    {"status": "ok", "ref": "browserref:driver-accessor"},
                )
                request = self.observed[name + "Request"]
                self.assertEqual(request["version"], 1)
                self.assertEqual(request["authority"], "unchanged")
                self.assertEqual(request["capability"], "browser.navigate")
                self.assertEqual(request["command"], {
                    "kind": "navigate",
                    "session_key": "browsersession:" + "a" * 64,
                    "url": "https://example.com/driver-accessor",
                })
                self.assertRegex(request["profile_fingerprint"], r"^[0-9a-f]{64}$")
                self.assertRegex(request["request_fingerprint"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
