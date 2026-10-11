/** #468: observador HTTP local opt-in, solo lectura y fuentes sintéticas. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { projectLocalObserverSnapshot } from '../src/local-observer-snapshot.ts';
import { renderLocalObserverHtml } from '../src/local-observer-html.ts';

const HOST = '127.0.0.1';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DEMO = { version: 1, provenance: 'synthetic', freshness: 'UNKNOWN',
  observed_at: null, capacity: { total: null, available: null },
  queue: { pending: null, blocked: null }, runners: [] };

export type LocalObserverServerHandle = {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

/** No filesystem, cookies, network egress, runner execution, real clients or upstream services. */
export async function startLocalObserverServer(fixture: unknown, port = 0): Promise<LocalObserverServerHandle> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('invalid_local_port');
  }
  const projected = projectLocalObserverSnapshot(fixture);
  // Initial server is synthetic-only, even if a caller supplies observed/cached data.
  const view = projected.provenance === 'synthetic' && projected.freshness === 'UNKNOWN'
    ? projected : projectLocalObserverSnapshot(null);
  const html = renderLocalObserverHtml(view);
  if (Buffer.byteLength(html, 'utf8') > 65536) throw new TypeError('oversized_local_view');

  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const headers = {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    };
    function reply(status: number, body: string, type = 'text/plain; charset=utf-8') {
      res.writeHead(status, { ...headers, 'Content-Type': type,
        'Content-Length': Buffer.byteLength(body, 'utf8') });
      res.end(body);
    }
    const address = server.address();
    if (!address || typeof address === 'string') { reply(503, 'UNKNOWN'); return; }
    const authority = HOST + ':' + address.port;
    const hosts: string[] = [];
    const origins: string[] = [];
    for (let n = 0; n < req.rawHeaders.length; n += 2) {
      const key = req.rawHeaders[n].toLowerCase();
      if (key === 'host') hosts.push(req.rawHeaders[n + 1]);
      if (key === 'origin') origins.push(req.rawHeaders[n + 1]);
    }
    if (req.socket.localAddress !== HOST || req.socket.remoteAddress !== HOST
        || hosts.length !== 1 || hosts[0] !== authority
        || origins.length > 1 || (origins.length === 1
          && origins[0] !== 'http://' + authority)) {
      reply(403, 'forbidden_local_origin'); return;
    }
    if (req.method !== 'GET') { reply(405, 'get_only'); return; }
    if (req.headers['content-length'] !== undefined
        || req.headers['transfer-encoding'] !== undefined) {
      reply(400, 'get_body_denied'); return;
    }
    if (req.url === '/') { reply(200, html, 'text/html; charset=utf-8'); return; }
    if (req.url === '/health') {
      reply(200, '{"mode":"synthetic_only","readiness":"UNKNOWN"}',
        'application/json; charset=utf-8');
      return;
    }
    reply(404, 'unknown_local_route');
  });
  server.requestTimeout = 4000;
  server.headersTimeout = 4000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 20;
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.off('error', reject);
      done();
    });
  });
  const address = server.address() as AddressInfo;
  if (address.address !== HOST || address.family !== 'IPv4') {
    server.close();
    throw new TypeError('non_loopback_listener');
  }
  return { server, port: address.port, url: 'http://' + HOST + ':' + address.port,
    close: () => new Promise<void>((done, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : done());
    }) };
}

// Running an imported module never opens a listener. CLI requires two explicit args.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const portArg = args.find((item) => item.startsWith('--port='));
  const portNumber = portArg && /^--port=[0-9]{1,5}$/.test(portArg)
    ? Number(portArg.slice(7)) : null;
  if (args.length !== 2 || !args.includes('--demo') || portNumber === null
      || portNumber < 1 || portNumber > 65535) {
    process.stderr.write('Uso: node --experimental-strip-types scripts/local-observer-server.ts --demo --port=8765\n');
    process.exitCode = 2;
  } else {
    startLocalObserverServer(DEMO, portNumber)
      .then((handle) => { process.stdout.write('Observador local sintético: ' + handle.url + ' (NO LIVE)\n'); })
      .catch(() => { process.stderr.write('Listener local no disponible.\n'); process.exitCode = 1; });
  }
}
