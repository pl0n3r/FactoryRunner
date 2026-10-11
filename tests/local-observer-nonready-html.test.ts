import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

const AT = '2026-10-11T12:00:00Z';
const READY_AT = '2026-10-11T11:59:30Z';

function packet(extra: Record<string, unknown> = {}) {
  return {
    version: 1, provenance: 'observed', freshness: 'FRESH', observed_at: AT,
    capacity: {total: 3, available: 1}, queue: {pending: 2, blocked: 1},
    runners: [{id: 'runner-abc', status: 'READY', reason: 'NONE',
      heartbeat_at: READY_AT, last_outcome: 'SUCCESS'}],
    ...extra,
  };
}

test('AC01 renderer denies positive capacity with a nonready roster', () => {
  for (const [status, reason] of [
    ['OFFLINE', 'STALE'], ['WAITING', 'NO_CAPACITY'], ['BLOCKED', 'HUMAN_GATE'],
  ] as const) {
    for (const available of [1, 2, 3]) {
      const input = packet({capacity: {total: 3, available},
        runners: [{id: 'runner-abc', status, reason,
          heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'}]});
      const before = JSON.stringify(input);
      const html = renderLocalObserverHtml(input);
      assert.equal(JSON.stringify(input), before, 'render must not mutate input');
      assert.match(html, /UNKNOWN: snapshot inválido/, status);
      assert.match(html, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
      assert.doesNotMatch(html, /OBSERVED · FRESH reportado/);
      assert.doesNotMatch(html, /runner-abc|2026-10-11T12:00:00Z/);
    }
  }
  const mixed = renderLocalObserverHtml(packet({runners: [
    {id: 'runner-abc', status: 'WAITING', reason: 'NO_CAPACITY',
      heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'},
    {id: 'runner-def', status: 'OFFLINE', reason: 'STALE',
      heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'},
  ]}));
  assert.match(mixed, /UNKNOWN: snapshot inválido/);
});

test('AC02 fresh READY and nonpositive availability remain compatible', () => {
  const ready = renderLocalObserverHtml(packet());
  assert.match(ready, /OBSERVED · FRESH reportado · SIN VALIDACIÓN EN PRODUCCIÓN/);
  assert.match(ready, /Capacidad disponible<span class="value">1<\/span>/);
  assert.match(ready, /READY \(reportado\)/);
  const edge = renderLocalObserverHtml(packet({runners: [
    {id: 'runner-abc', status: 'READY', reason: 'NONE',
      heartbeat_at: '2026-10-11T11:58:30Z', last_outcome: 'SUCCESS'},
  ]}));
  assert.match(edge, /Capacidad disponible<span class="value">1<\/span>/);
  const stale = renderLocalObserverHtml(packet({runners: [
    {id: 'runner-abc', status: 'READY', reason: 'NONE',
      heartbeat_at: '2026-10-11T11:58:29Z', last_outcome: 'SUCCESS'},
  ]}));
  assert.match(stale, /UNKNOWN: snapshot inválido/);
  for (const available of [0, null]) {
    for (const status of ['OFFLINE', 'WAITING', 'BLOCKED'] as const) {
      const html = renderLocalObserverHtml(packet({
        capacity: {total: 3, available},
        runners: [{id: 'runner-abc', status, reason: 'NO_CAPACITY',
          heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'}],
      }));
      assert.match(html, /OBSERVED · FRESH reportado · SIN VALIDACIÓN EN PRODUCCIÓN/);
      assert.match(html, new RegExp('Capacidad disponible<span class="value">'
        + (available === null ? 'UNKNOWN' : '0') + '<\\/span>'));
      assert.match(html, new RegExp(status + ' \\(reportado\\)'));
    }
  }
  const synthetic = renderLocalObserverHtml(packet({
    provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
    capacity: {total: null, available: null},
    runners: [{id: 'runner-abc', status: 'UNKNOWN', reason: 'UNKNOWN',
      heartbeat_at: null, last_outcome: 'UNKNOWN'}],
  }));
  assert.match(synthetic, /NO LIVE · SYNTHETIC · UNKNOWN/);
  const cached = renderLocalObserverHtml(packet({
    provenance: 'cached', freshness: 'STALE', capacity: {total: 3, available: null},
    runners: [{id: 'runner-abc', status: 'UNKNOWN', reason: 'STALE',
      heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'}],
  }));
  assert.match(cached, /NO LIVE · CACHED · STALE/);
  assert.doesNotMatch(cached, /Capacidad disponible<span class="value">[1-9]/);
});

test('AC03 invalid direct input never leaks payload or active markup', () => {
  const input = packet({
    capacity: {total: 3, available: 2},
    queue: {pending: 987654, blocked: 4321},
    runners: [{id: 'runner-abc', status: 'BLOCKED', reason: 'HUMAN_GATE',
      heartbeat_at: READY_AT, last_outcome: 'UNKNOWN'}],
  });
  const html = renderLocalObserverHtml(input);
  assert.match(html, /UNKNOWN: snapshot inválido/);
  assert.match(html, /Capacidad total<span class="value">UNKNOWN<\/span>/);
  assert.match(html, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
  assert.match(html, /En espera \/ bloqueados<span class="value">UNKNOWN \/ UNKNOWN<\/span>/);
  assert.doesNotMatch(html, /987654|4321|runner-abc|2026-10-11T12:00:00Z/);
  assert.doesNotMatch(html, /<\s*(?:script|form|button|iframe|a)\b/i);
  assert.doesNotMatch(html, /(?:javascript:|https?:\/\/|data:)/i);
  const malicious = renderLocalObserverHtml(packet({runners: [
    {id: '<svg onload=alert(1)>', status: 'READY',
      reason: 'NONE', heartbeat_at: READY_AT, last_outcome: 'SUCCESS'},
  ]}));
  assert.match(malicious, /UNKNOWN: snapshot inválido/);
  assert.doesNotMatch(malicious, /<svg|onload|runner-abc/);
});
