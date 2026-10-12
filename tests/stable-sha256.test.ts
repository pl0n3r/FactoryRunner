import assert from 'node:assert/strict';
import test from 'node:test';
import { stableSha256 } from '../src/validation.ts';

const EMPTY_SHA = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

test('AC01 proto key affects root JSON fingerprint', () => {
  const root = JSON.parse('{"__proto__":{"admin":true}}');
  assert.equal(stableSha256({}), EMPTY_SHA);
  assert.equal(stableSha256(root), '4366da302d5cc26a51294b6391fd85155985b14d7388bf6aa945386a9ea18281');
  assert.notEqual(stableSha256(root), EMPTY_SHA);
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});

test('AC02 nested escaped proto and constructor remain material', () => {
  const nested = JSON.parse('{"ok":{"__proto__":{"admin":true}}}');
  const escaped = JSON.parse('{"\\u005f\\u005fproto__":{"admin":true}}');
  const constructor = JSON.parse('{"constructor":{"admin":true}}');
  const prototype = JSON.parse('{"prototype":{"admin":true}}');
  assert.equal(stableSha256(nested), 'a1a3f2dedf6b82c116a959bbc0fa6eeae8f2e7b483f227dafc5d281c06e37065');
  assert.equal(stableSha256(escaped), stableSha256(JSON.parse('{"__proto__":{"admin":true}}')));
  assert.notEqual(stableSha256(nested), stableSha256({ ok: {} }));
  assert.notEqual(stableSha256(constructor), stableSha256({}));
  assert.notEqual(stableSha256(prototype), stableSha256({}));
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});

test('AC03 ordinary JSON hashes remain backward-compatible', () => {
  assert.equal(stableSha256({}), EMPTY_SHA);
  assert.equal(stableSha256({ z: 9, a: 1 }), '5e73e7b550c9f8c9ad7c64f5e1b6b1d8bd4b6d2720ac37834ebb183d058907b1');
  assert.equal(stableSha256({ z: 9, a: 1 }), stableSha256({ a: 1, z: 9 }));
  assert.equal(stableSha256({ fields: [3, 2, 1], active: true }), stableSha256({ active: true, fields: [3, 2, 1] }));
  assert.notEqual(stableSha256([1, 2]), stableSha256([2, 1]));
});

test('AC04 distinct Unicode keys with equal collation produce insertion-independent hashes', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.notEqual(composed, decomposed);
  assert.equal(composed.localeCompare(decomposed, 'en'), 0);
  const forward = { [composed]: 1, [decomposed]: 2 };
  const reversed = { [decomposed]: 2, [composed]: 1 };
  assert.equal(stableSha256(forward), stableSha256(reversed));
  assert.notEqual(stableSha256(forward), stableSha256({ [composed]: 1 }));
});

test('AC05 nested Unicode collation ties remain insertion-independent', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  const forward = {
    outer: { [composed]: { active: true }, [decomposed]: [2, 1] },
    other: 'ok',
  };
  const reversed = {
    other: 'ok',
    outer: { [decomposed]: [2, 1], [composed]: { active: true } },
  };
  assert.equal(stableSha256(forward), stableSha256(reversed));
  assert.notEqual(stableSha256(forward), stableSha256({ outer: { [composed]: { active: true } }, other: 'ok' }));
});
