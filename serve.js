// Local server for the editor. Serves the app on http://localhost (where Chrome/Edge
// allow saving straight back to the opened file) and proxies Claude requests so the
// API key stays on this machine and never reaches the browser.
//   node serve.js            start and open the browser
//   node serve.js --no-open  start only
//   AIDE_MOCK=1              canned generation output, no API calls
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const claude = require('./server/claude');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5178;
const STATIC_DIRS = ['/css/', '/js/', '/samples/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// API calls must come from this app: right Host, same-origin, and a custom header
// (which other sites cannot send without a CORS preflight this server never answers).
function apiAllowed(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return req.method === 'GET' || req.headers['x-aide'] === '1';
}

async function handleApi(req, res, p) {
  if (!apiAllowed(req)) return sendJSON(res, 403, { error: 'Forbidden' });

  if (p === '/api/status' && req.method === 'GET') {
    const fresh = new URL(req.url, 'http://localhost').searchParams.has('fresh');
    return sendJSON(res, 200, await claude.status({ fresh }));
  }

  if (p === '/api/settings' && req.method === 'POST') {
    try {
      return sendJSON(res, 200, await claude.saveSettings(await readBody(req)));
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (p === '/api/generate' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    // Newline-delimited JSON stream of progress events.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = obj => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
    };
    let abort = null;
    let finished = false;
    res.on('close', () => {
      if (!finished && abort) abort();
    });
    try {
      await claude.generate(body, send, fn => (abort = fn));
    } catch (e) {
      if (!res.destroyed) {
        console.error('[generate]', e && e.message);
        send({ event: 'error', message: claude.describeError(e) });
      }
    }
    finished = true;
    return res.end();
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  if (p !== '/index.html' && !STATIC_DIRS.some(d => p.startsWith(d))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (p.startsWith('/api/')) return handleApi(req, res, p);
    serveStatic(req, res, p);
  })
  .listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`AID Scenario Editor running at ${url}  (Ctrl+C to stop)`);
    if (process.env.AIDE_MOCK) console.log('Mock mode: generation returns placeholder content, no API calls.');
    if (!process.argv.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd);
    }
  })
  .on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use — is the editor already running? Open http://localhost:${PORT}/`);
    else console.error(e);
    process.exit(1);
  });
