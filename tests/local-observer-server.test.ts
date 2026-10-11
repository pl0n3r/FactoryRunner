import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { startLocalObserverServer } from '../scripts/local-observer-server.ts';

const FIXTURE = { version: 1, provenance: 'synthetic', freshness: 'UNKNOWN',
  observed_at: null, capacity: { total: null, available: null },
  queue: { pending: null, blocked: null }, runners: [] };

type Result = { status: number | undefined; headers: Record<string, unknown>; body: string };
function get(port: number, options: { path?: string; method?: string; host?: string;
  origin?: string; headers?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((done, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? '127.0.0.1:' + port, ...options.headers,
    };
    if (options.origin !== undefined) headers.Origin = options.origin;
    const req = request({hostname: '127.0.0.1', port, path: options.path ?? '/',
      method: options.method ?? 'GET', headers, agent: false, timeout: 3000}, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('AC01 loopback GET only and no outgoing HTTP', async () => {
  const handle = await startLocalObserverServer(FIXTURE);
  try {
    const address = handle.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.family, 'IPv4');
    const page = await get(handle.port);
    assert.equal(page.status, 200);
    assert.match(page.body, /FactoryRunner · Observador local/);
    assert.match(page.body, /NO LIVE/);
    assert.match(page.body, /UNKNOWN/);
    assert.ok(!/<script\b|<form\b|<button\b|<iframe\b/i.test(page.body));
    assert.equal(page.headers['cache-control'], 'no-store, max-age=0');
    assert.ok(String(page.headers['content-security-policy']).includes("default-src 'none'"));
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    const health = await get(handle.port, {path: '/health'});
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body),
      {mode: 'synthetic_only', readiness: 'UNKNOWN'});
  } finally { await handle.close(); }
});

test('AC02 only localhost bind, GET and allowlisted routes', async () => {
  for (const port of [-1, 65536, NaN, Infinity, 1.5, true, '9999']) {
    await assert.rejects(() => startLocalObserverServer(FIXTURE, port as number),
      /invalid_local_port/);
  }
  const handle = await startLocalObserverServer(FIXTURE);
  try {
    for (const method of ['POST', 'PUT', 'HEAD', 'DELETE', 'OPTIONS']) {
      assert.equal((await get(handle.port, {method})).status, 405);
    }
    for (const path of ['/admin', '/execute', '/%2F', '//', '/?token=FAKE']) {
      assert.equal((await get(handle.port, {path})).status, 404);
    }
    assert.equal((await get(handle.port,
      {headers: {'Content-Length': '0'}})).status, 400);
    // A body must be rejected before the client gets provisional 100 Continue.
    const premature = await new Promise<{status: number | undefined;
      continued: boolean; headers: Record<string, unknown>}>((done, reject) => {
      let continued = false;
      const req = request({hostname: '127.0.0.1', port: handle.port, path: '/',
        method: 'GET', agent: false, timeout: 3000, headers: {
          Host: '127.0.0.1:' + handle.port, Expect: '100-continue',
          'Content-Length': '1048576',
        }}, (res) => {
        res.resume();
        res.on('end', () => done({status: res.statusCode, continued,
          headers: res.headers}));
      });
      req.on('continue', () => { continued = true; });
      req.on('error', reject);
      req.end();
    });
    assert.equal(premature.status, 417);
    assert.equal(premature.continued, false);
    assert.equal(premature.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(premature.headers['access-control-allow-origin'], undefined);
  } finally { await handle.close(); }
});

test('AC03 observed stale invalid and private input never grants authority', async () => {
  const observed = { version: 1, provenance: 'observed', freshness: 'FRESH',
    observed_at: '2026-10-11T11:00:00Z', capacity: {total: 4, available: 4},
    queue: {pending: 0, blocked: 0}, runners: [
      {id: 'runner-abc', status: 'READY', reason: 'NONE',
        heartbeat_at: '2026-10-11T11:00:00Z', last_outcome: 'SUCCESS'},
    ] };
  for (const fixture of [observed, {token: 'FAKE-PRIVATE-SENTINEL'}, null]) {
    const handle = await startLocalObserverServer(fixture);
    try {
      const page = await get(handle.port);
      assert.equal(page.status, 200);
      assert.match(page.body, /UNKNOWN/);
      assert.ok(!page.body.includes('FAKE-PRIVATE-SENTINEL'));
      assert.ok(!page.body.includes('runner-abc'));
      assert.ok(!page.body.includes('Capacidad disponible<span class="value">4'));
      assert.equal((await get(handle.port, {method:'POST',path:'/execute'})).status, 405);
    } finally { await handle.close(); }
  }
});

test('AC04 exact Host Origin and no CORS or DNS rebinding', async () => {
  const handle = await startLocalObserverServer(FIXTURE);
  try {
    const port = handle.port;
    for (const host of ['localhost', 'localhost:'+port, '127.0.0.1',
      '127.0.0.1.attacker.example:'+port, '127.0.0.2:'+port,
      '127.0.0.1:'+(port+1), 'evil.test:'+port]) {
      const result = await get(port, {host});
      assert.equal(result.status, 403, host);
      assert.ok(!result.body.includes('FactoryRunner · Observador local'));
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.equal(result.headers.location, undefined);
    }
    for (const origin of ['http://evil.test', 'null',
      'https://127.0.0.1:'+port, 'http://localhost:'+port,
      'http://127.0.0.1:'+(port+1)]) {
      const result = await get(port, {origin});
      assert.equal(result.status, 403, origin);
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.equal(result.headers.location, undefined);
    }
    const okay = await get(port, {origin: 'http://127.0.0.1:'+port});
    assert.equal(okay.status, 200);
  } finally { await handle.close(); }
});
