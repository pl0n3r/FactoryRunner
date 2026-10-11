import assert from 'node:assert/strict';
import test from 'node:test';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

const AT = '2026-10-11T12:00:00Z';
function packet(extra: Record<string, unknown> = {}) {
  return {
    version: 1, provenance: 'observed', freshness: 'FRESH', observed_at: AT,
    capacity: {total: 3, available: 1}, queue: {pending: 0, blocked: 0},
    runners: [], ...extra,
  };
}

test('AC01 renderer direct FRESH empty roster rejects positive capacity', () => {
  for (const available of [1, 2, 3]) {
    const data = packet({capacity: {total: 3, available}});
    const original = JSON.stringify(data);
    const html = renderLocalObserverHtml(data);
    assert.equal(JSON.stringify(data), original, 'renderer must not mutate input');
    assert.match(html, /UNKNOWN: snapshot inválido/);
    assert.match(html, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
    assert.doesNotMatch(html, /Capacidad disponible<span class="value">[1-9]/);
    assert.doesNotMatch(html, /OBSERVED · FRESH reportado/);
    assert.doesNotMatch(html, new RegExp(AT));
  }
});

test('AC02 zero null and fresh nonempty roster remain compatible', () => {
  const zero = renderLocalObserverHtml(packet({capacity: {total: 3, available: 0}}));
  assert.match(zero, /OBSERVED · FRESH reportado · SIN VALIDACIÓN EN PRODUCCIÓN/);
  assert.match(zero, /Capacidad disponible<span class="value">0<\/span>/);
  assert.match(zero, /No hay runners verificables/);
  const unknown = renderLocalObserverHtml(packet({capacity: {total: 3, available: null}}));
  assert.match(unknown, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
  assert.match(unknown, /No hay runners verificables/);
  const liveLike = renderLocalObserverHtml(packet({runners: [{
    id: 'runner-abc', status: 'READY', reason: 'NONE',
    heartbeat_at: '2026-10-11T11:59:30Z', last_outcome: 'SUCCESS',
  }]}));
  assert.match(liveLike, /Capacidad disponible<span class="value">1<\/span>/);
  assert.match(liveLike, /runner-abc/);
  assert.match(liveLike, /READY \(reportado\)/);
  assert.match(liveLike, /SIN VALIDACIÓN EN PRODUCCIÓN/);
  for (const stale of [
    packet({provenance: 'synthetic', freshness: 'UNKNOWN', observed_at: null,
      capacity: {total: null, available: null}}),
    packet({provenance: 'cached', freshness: 'STALE',
      capacity: {total: 3, available: null}}),
  ]) {
    const html = renderLocalObserverHtml(stale);
    assert.match(html, /NO LIVE/);
    assert.match(html, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
  }
  assert.match(zero, /role="region"/);
  assert.match(zero, /<caption>/);
  assert.match(zero, /tabindex="0"/);
});

test('AC03 fallback has no active markup or private data leak', () => {
  const invalid = packet({capacity: {total: 3, available: 1},
    queue: {pending: 987654, blocked: 4321}});
  const html = renderLocalObserverHtml(invalid);
  assert.match(html, /UNKNOWN: snapshot inválido/);
  assert.match(html, /Capacidad total<span class="value">UNKNOWN<\/span>/);
  assert.match(html, /Capacidad disponible<span class="value">UNKNOWN<\/span>/);
  assert.match(html, /En espera \/ bloqueados<span class="value">UNKNOWN \/ UNKNOWN<\/span>/);
  assert.doesNotMatch(html, /987654|4321/);
  assert.doesNotMatch(html, new RegExp(AT));
  assert.doesNotMatch(html, /<\s*(?:script|form|button|iframe|a)\b/i);
  assert.doesNotMatch(html, /(?:javascript:|https?:\/\/|data:)/i);
  const privateValue = packet({runners: [{
    id: 'PRIVATE-SYNTHETIC-SENTINEL', status: 'READY', reason: 'NONE',
    heartbeat_at: AT, last_outcome: 'SUCCESS',
  }]});
  const denied = renderLocalObserverHtml(privateValue);
  assert.match(denied, /UNKNOWN: snapshot inválido/);
  assert.doesNotMatch(denied, /PRIVATE-SYNTHETIC-SENTINEL/);
  assert.doesNotMatch(denied, /<\s*(?:script|form|button|iframe|a)\b/i);
});
