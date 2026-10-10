import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

function snapshot() {
  return {
    version: 1, provenance: 'observed', freshness: 'FRESH', observed_at: '2026-10-10T12:00:00Z',
    capacity: { total: 3, available: 1 }, queue: { pending: 2, blocked: 1 },
    runners: [{ id: 'runner-001', status: 'READY', reason: 'NONE', heartbeat_at: '2026-10-10T12:00:00Z', last_outcome: 'SUCCESS' }],
  };
}

test('render escapes untrusted content and excludes active resources', () => {
  const hostile = snapshot();
  hostile.runners[0].id = `<img src=x onerror="alert('oops')"> & <script>eval(1)</script>`;
  const before = JSON.stringify(hostile);
  const html = renderLocalObserverHtml(hostile);
  assert.equal(JSON.stringify(hostile), before, 'input stays unchanged');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;'));
  assert.ok(html.includes('&lt;script&gt;eval(1)&lt;/script&gt;'));
  assert.ok(!/<\s*(script|img|iframe|form|button|a|link)\b/i.test(html));
  assert.ok(!/https?:\/\//i.test(html));
  assert.ok(!html.includes('alert(\'oops\')">'));
  const shifting = snapshot();
  let reasonReads = 0;
  let timeReads = 0;
  Object.defineProperty(shifting.runners[0], 'reason', {
    enumerable: true,
    get() { return ++reasonReads === 1 ? 'NONE' : '<img src=x onerror=alert(1)>'; },
  });
  Object.defineProperty(shifting, 'observed_at', {
    enumerable: true,
    get() { return ++timeReads === 1 ? '2026-10-10T12:00:00Z' : '<svg onload=alert(1)>'; },
  });
  const stable = renderLocalObserverHtml(shifting);
  assert.ok(!/<\s*(img|svg|script)\b/i.test(stable));
  assert.equal(reasonReads, 0, 'accessors must not be invoked even during preflight');
  assert.equal(timeReads, 0, 'hostile timestamp accessors never execute');
  assert.match(stable, /UNKNOWN: snapshot inválido/);
  const throwing = snapshot();
  Object.defineProperty(throwing.runners[0], 'last_outcome', {
    enumerable: true,
    get() { throw new Error('SECRET-SENTINEL'); },
  });
  const fallback = renderLocalObserverHtml(throwing);
  assert.match(fallback, /UNKNOWN: snapshot inválido/);
  assert.ok(!fallback.includes('SECRET-SENTINEL'));
  // Resource-limit regression: invalid input cannot trigger a 12 MiB clone.
  const oversized = { ...snapshot(), unexpected: 'X'.repeat(12 * 1024 * 1024) };
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => {
    clones += 1;
    return originalClone(...args);
  }) as typeof structuredClone;
  try {
    assert.match(renderLocalObserverHtml(oversized), /UNKNOWN: snapshot inválido/);
    assert.equal(clones, 0, 'invalid oversized payload cannot reach structuredClone');
    assert.match(renderLocalObserverHtml({ ...snapshot(), runners: Array(500).fill(snapshot().runners[0]) }), /UNKNOWN: snapshot inválido/);
    assert.equal(clones, 0, 'oversized runner list cannot reach structuredClone');
    const validOutput = renderLocalObserverHtml(snapshot());
    assert.match(validOutput, /SIN VALIDACIÓN EN PRODUCCIÓN/);
    assert.equal(clones, 1, 'valid small snapshot is cloned once');
  } finally {
    globalThis.structuredClone = originalClone;
  }
  const privateInput = { ...snapshot(), token: 'PRIVATE-SENTINEL' };
  const rejected = renderLocalObserverHtml(privateInput);
  assert.ok(rejected.includes('snapshot inválido'));
  assert.ok(!rejected.includes('PRIVATE-SENTINEL'));
});

test('390 and 1440 viewports have semantic responsive accessible layout', () => {
  const item = snapshot();
  item.runners[0].id = 'LONG-'.repeat(20);
  const html = renderLocalObserverHtml(item);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /@media\(min-width:601px\)/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /<main>/);
  assert.match(html, /<h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<caption>/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /<th scope="row">/);
  assert.match(html, /role="region" aria-label=/);
  assert.match(html, /tabindex="0"/);
  assert.ok(html.includes(item.runners[0].id), 'legible long IDs are not truncated');
});

test('unknown stale and empty states never claim live GREEN or enable actions', () => {
  const observed = renderLocalObserverHtml(snapshot());
  assert.match(observed, /SIN VALIDACIÓN EN PRODUCCIÓN/);
  const sample = { ...snapshot(), provenance: 'synthetic', freshness: 'FRESH' };
  const synthetic = renderLocalObserverHtml(sample);
  assert.match(synthetic, /NO LIVE · SYNTHETIC · FRESH/);
  assert.match(synthetic, /READY \(dato no verificado\)/);
  const stale = renderLocalObserverHtml({ ...snapshot(), provenance: 'cached', freshness: 'STALE' });
  assert.match(stale, /NO LIVE · CACHED · STALE/);
  const empty = renderLocalObserverHtml({ ...snapshot(), runners: [], capacity: { total: null, available: null }, queue: { pending: null, blocked: null } });
  assert.match(empty, /No hay runners verificables/);
  assert.match(empty, /UNKNOWN/);
  const invalid = renderLocalObserverHtml({ ...snapshot(), runners: [{ ...snapshot().runners[0], status: 'GREEN' }] });
  assert.match(invalid, /UNKNOWN: snapshot inválido/);
  for (const html of [observed, synthetic, stale, empty, invalid]) {
    assert.doesNotMatch(html, /<\s*(button|form|script|iframe|a)\b/i);
    assert.doesNotMatch(html, /producción (GREEN|verificada)/i);
  }
});
