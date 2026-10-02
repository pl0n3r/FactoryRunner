"""Aceptación del snapshot inmutable de allowed origins (#209)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { browserRemoteOriginPolicy } from './src/browser-remote-origin-policy.ts';

function rejected(value) {
  try {
    browserRemoteOriginPolicy(value);
    return false;
  } catch {
    return true;
  }
}

const source = [
  'https://EXAMPLE.com/',
  'https://api.example.com',
];
const snapshot = browserRemoteOriginPolicy(source);
const frozenBeforeMutation = Object.isFrozen(snapshot);
const before = [...snapshot];
source[0] = 'https://evil.example';
source.push('https://later.example');
const after = [...snapshot];

const duplicateCanonicalRejected = rejected([
  'https://EXAMPLE.com/',
  'https://example.com',
]);
const emptyRejected = rejected([]);
const tooManyRejected = rejected(
  Array.from({ length: 33 }, (_, index) => `https://h${index}.example.com`),
);
const invalidCases = {
  http: rejected(['http://example.com']),
  path: rejected(['https://example.com/path']),
  userinfo: rejected(['https://user:pass@example.com']),
  query: rejected(['https://example.com?x=1']),
  hash: rejected(['https://example.com#x']),
  nonArray: rejected('https://example.com'),
};

console.log(JSON.stringify({
  frozenBeforeMutation,
  before,
  after,
  source,
  duplicateCanonicalRejected,
  emptyRejected,
  tooManyRejected,
  invalidCases,
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


class FactoryRunnerBrowserRemoteOriginPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_allowed_origins_are_canonicalized_copied_and_frozen(self):
        self.assertTrue(self.observed["frozenBeforeMutation"])
        self.assertEqual(
            self.observed["before"],
            ["https://example.com", "https://api.example.com"],
        )
        self.assertEqual(self.observed["after"], self.observed["before"])

    def test_mutating_source_array_cannot_expand_snapshot_and_invalid_origins_fail_closed(self):
        self.assertEqual(
            self.observed["source"],
            [
                "https://evil.example",
                "https://api.example.com",
                "https://later.example",
            ],
        )
        self.assertTrue(self.observed["duplicateCanonicalRejected"])
        self.assertTrue(self.observed["emptyRejected"])
        self.assertTrue(self.observed["tooManyRejected"])
        for key, rejected in self.observed["invalidCases"].items():
            with self.subTest(case=key):
                self.assertTrue(rejected)


if __name__ == "__main__":
    unittest.main()
