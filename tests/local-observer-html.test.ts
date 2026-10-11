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
  assert.match(html, /UNKNOWN: snapshot inválido/);
  assert.ok(!html.includes(hostile.runners[0].id));
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
  item.runners[0].id = 'runner-' + 'a'.repeat(48);
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
  // Representative output shapes of sibling projector #466, no cross-branch import.
  const sample = { ...snapshot(), provenance: 'synthetic', freshness: 'UNKNOWN',
    observed_at: null, capacity: { total: 3, available: null },
    runners: [{ ...snapshot().runners[0], status: 'UNKNOWN', reason: 'UNKNOWN', last_outcome: 'UNKNOWN' }] };
  const synthetic = renderLocalObserverHtml(sample);
  assert.match(synthetic, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.match(synthetic, /UNKNOWN \(reportado\)/);
  // The sibling producer maps a synthetic STALE source to synthetic/UNKNOWN,
  // preserving STALE as the individual runner reason.
  const syntheticFromStale = renderLocalObserverHtml({ ...sample,
    runners: [{ ...sample.runners[0], reason: 'STALE' }] });
  assert.match(syntheticFromStale, /NO LIVE · SYNTHETIC · UNKNOWN/);
  assert.match(syntheticFromStale, /<td>STALE<\/td>/);
  assert.doesNotMatch(syntheticFromStale, /READY \(reportado\)/);
  const cachedInput = { ...snapshot(), provenance: 'cached', freshness: 'STALE',
    capacity: { total: 3, available: null },
    runners: [{ ...snapshot().runners[0], status: 'UNKNOWN', reason: 'STALE', last_outcome: 'UNKNOWN' }] };
  const stale = renderLocalObserverHtml(cachedInput);
  assert.match(stale, /NO LIVE · CACHED · STALE/);
  assert.match(stale, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
  const blocked = renderLocalObserverHtml({ ...snapshot(),
    runners: [{ ...snapshot().runners[0], status: 'UNKNOWN', reason: 'HUMAN_GATE', last_outcome: 'UNKNOWN' }] });
  assert.match(blocked, /UNKNOWN \(reportado\)/);
  assert.match(blocked, /HUMAN_GATE/);
  // Direct input must never relabel cached/synthetic/old evidence as fresh.
  for (const inconsistent of [
    { ...sample, freshness: 'FRESH' },
    { ...sample, observed_at: snapshot().observed_at },
    { ...cachedInput, freshness: 'FRESH' },
    { ...cachedInput, capacity: snapshot().capacity },
    { ...snapshot(), freshness: 'STALE' },
    { ...snapshot(), freshness: 'UNKNOWN' },
  ]) {
    assert.match(renderLocalObserverHtml(inconsistent), /UNKNOWN: snapshot inválido/);
  }
  const empty = renderLocalObserverHtml({ ...snapshot(), runners: [], capacity: { total: null, available: null }, queue: { pending: null, blocked: null } });
  assert.match(empty, /No hay runners verificables/);
  assert.match(empty, /UNKNOWN/);
  const invalid = renderLocalObserverHtml({ ...snapshot(), runners: [{ ...snapshot().runners[0], status: 'GREEN' }] });
  assert.match(invalid, /UNKNOWN: snapshot inválido/);
  const privateAlias = 'person' + String.fromCharCode(64) + 'example.test';
  for (const id of [privateAlias, 'runner-ABC', 'untrusted-runner-name']) {
    const html = renderLocalObserverHtml({ ...snapshot(),
      runners: [{ ...snapshot().runners[0], id }] });
    assert.match(html, /UNKNOWN: snapshot inválido/);
    assert.ok(!html.includes(id), 'a rejected identifier is never rendered');
  }
  for (const reason of ['HUMAN_GATE', 'CLAIMS', 'NO_CAPACITY', 'DEPENDENCY', 'STALE', 'UNKNOWN']) {
    const html = renderLocalObserverHtml({ ...snapshot(),
      runners: [{ ...snapshot().runners[0], reason }] });
    assert.match(html, /UNKNOWN: snapshot inválido/, 'READY with a blocker must be denied');
  }
  const atFreshnessEdge = renderLocalObserverHtml({ ...snapshot(),
    runners: [{ ...snapshot().runners[0], heartbeat_at: '2026-10-10T11:58:30Z' }] });
  assert.match(atFreshnessEdge, /READY \(reportado\)/);
  for (const heartbeat_at of [null, '2026-10-10T12:05:00Z', '2026-10-10T11:58:29Z']) {
    const html = renderLocalObserverHtml({ ...snapshot(),
      runners: [{ ...snapshot().runners[0], heartbeat_at }] });
    assert.match(html, /UNKNOWN: snapshot inválido/, 'unproven/future heartbeat cannot support READY');
  }
  assert.match(renderLocalObserverHtml({ ...snapshot(), observed_at: null }),
    /UNKNOWN: snapshot inválido/);
  for (const html of [observed, synthetic, stale, empty, invalid]) {
    assert.doesNotMatch(html, /<\s*(button|form|script|iframe|a)\b/i);
    assert.doesNotMatch(html, /producción (GREEN|verificada)/i);
  }
});
