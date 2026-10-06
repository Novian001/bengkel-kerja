// WHY server.js is 20 lines: node:http already does the only hard part (accepting sockets and
// streaming a body). Everything that carries meaning is in routes.js, so this file's job is
// to open the DB, decide whether to seed, mount the handler, and shut down cleanly. Tests
// import start() and get a real socket on port 0 instead of mocking anything.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, all } from '../db.js';
import { seed } from '../seed.js';
import { createHandler } from './routes.js';

// WHY static serving sits in front of the router instead of inside routes.js: the API must keep
// answering every unknown path with JSON (a 404 on /api/typo is a test, not a page), while the
// browser needs the SAME origin for / so the whole app is one process with no dev server and no
// CORS. One pre-handler for non-API paths satisfies both without a second router.
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, next) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (pathname.startsWith('/api') || pathname === '/health') return next();
  const want = normalize(pathname === '/' ? '/index.html' : pathname);
  // normalize() collapses '..' but a crafted path can still escape; the prefix check is the guard
  const file = join(FRONTEND, want);
  if (file !== FRONTEND && !file.startsWith(FRONTEND + '/')) return next();
  let body;
  try { body = await readFile(file); } catch { return next(); }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// `listen` is async, so start() resolves only once the socket is bound: callers (and tests) get
// a usable URL immediately instead of racing to connect to a server that is not up yet.
export function start({ port = 0, dbFile = 'backend/data/bengkel.db', seedIfEmpty = true, db = null } = {}) {
  const database = db ?? openDb(dbFile);
  migrate(database);
  if (seedIfEmpty) seed(database, { log: (m) => process.stdout.write(`${m}\n`) });
  const server = createServer((req, res) => {
    serveStatic(req, res, () => createHandler(database)(req, res)).catch((e) => {
      process.stderr.write(`[500] static ${req.method} ${req.url}: ${e?.stack ?? e}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        db: database,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => { database.close(); done(); });
        }),
      });
    });
  });
}

// `node backend/src/http/server.js` is the whole run story for this repo: no build, no env.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const app = await start({ port, dbFile: process.env.DB_FILE ?? 'backend/data/bengkel.db' });
  process.stdout.write(`BengkelKerja on ${app.url} (${all(app.db, 'SELECT COUNT(*) AS n FROM jobs')[0].n} jobs)\n`);
  const bye = () => { app.close().then(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
