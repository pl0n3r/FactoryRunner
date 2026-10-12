"""Validación estricta de claves propias para contratos FactoryRunner (#552)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { exactKeys, stableSha256 } from './src/validation.ts';

function rejects(value, expected = ['version', 'status']) {
  try { exactKeys(value, expected, 'StrictKeysV1'); return false; }
  catch (error) {
    return error instanceof TypeError
      && error.message === 'StrictKeysV1 contiene campos inválidos.';
  }
}
const original = { version: 1, status: 'ready' };
const hashBefore = stableSha256(original);
const plainJson = JSON.parse('{"version":1,"status":"ready"}');
let hiddenGetterCalls = 0;
const hidden = { version: 1, status: 'ready' };
Object.defineProperty(hidden, 'extra', {
  enumerable: false,
  get() { hiddenGetterCalls += 1; throw new Error('hidden getter must not execute'); },
});
const hiddenRejected = rejects(hidden);
let symbolGetterCalls = 0;
const symbol = { version: 1, status: 'ready' };
Object.defineProperty(symbol, Symbol('extra'), {
  enumerable: true,
  get() { symbolGetterCalls += 1; throw new Error('symbol getter must not execute'); },
});
const symbolRejected = rejects(symbol);
const plainAccepted = !rejects(plainJson);
const reverseOrderAccepted = !rejects({ status: 'ready', version: 1 });
const hashUnchanged = stableSha256(original) === hashBefore && stableSha256(plainJson) === hashBefore;
const missingRejected = rejects({ version: 1 });
const enumerableExtraRejected = rejects({ version: 1, status: 'ready', extra: 2 });
const noExpectedKeysAccepted = !rejects({}, []);
console.log(JSON.stringify({
  hiddenRejected, hiddenGetterCalls,
  symbolRejected, symbolGetterCalls,
  plainAccepted, reverseOrderAccepted, hashUnchanged,
  missingRejected, enumerableExtraRejected, noExpectedKeysAccepted,
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


class FactoryRunnerStrictKeysTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_non_enumerable_extra_own_field_rejected_without_getter(self):
        self.assertTrue(self.observed["hiddenRejected"])
        self.assertEqual(self.observed["hiddenGetterCalls"], 0)

    def test_symbol_extra_own_field_rejected_without_getter(self):
        self.assertTrue(self.observed["symbolRejected"])
        self.assertEqual(self.observed["symbolGetterCalls"], 0)

    def test_plain_json_exact_keys_and_existing_invalid_cases(self):
        self.assertTrue(self.observed["plainAccepted"])
        self.assertTrue(self.observed["reverseOrderAccepted"])
        self.assertTrue(self.observed["hashUnchanged"])
        self.assertTrue(self.observed["missingRejected"])
        self.assertTrue(self.observed["enumerableExtraRejected"])
        self.assertTrue(self.observed["noExpectedKeysAccepted"])


if __name__ == "__main__":
    unittest.main()
