// Tiny static file server so `npm run dev` works with no dependencies.
// Also proxies a few MangaUpdates API calls, because MangaUpdates blocks requests made from browsers.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const DISLIKED_FILE = path.join(ROOT, 'disliked.json');

const MU_API = 'https://api.mangaupdates.com/v1/';
const MU_ALLOWED = /^(series\/search|releases\/search|series\/\d+)$/;
const MU_CACHE_MS = 60 * 60 * 1000;
const muCache = new Map(); // "METHOD path body" -> { at, status, body }

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > limit) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function proxyMangaUpdates(req, res, muPath) {
  if (!MU_ALLOWED.test(muPath)) { res.writeHead(404).end(); return; }
  const body = req.method === 'POST' ? await readBody(req) : '';
  const key = `${req.method} ${muPath} ${body}`;
  let entry = muCache.get(key);
  if (!entry || Date.now() - entry.at > MU_CACHE_MS) {
    const upstream = await fetch(MU_API + muPath, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'random-manga-generator (local dev)' },
      body: req.method === 'POST' ? body : undefined,
    });
    entry = { at: Date.now(), status: upstream.status, body: await upstream.text() };
    if (upstream.ok) muCache.set(key, entry);
  }
  res.writeHead(entry.status, { 'Content-Type': 'application/json' }).end(entry.body);
}

// Dislikes live in a file rather than only in the browser: localStorage is per-port, so it would
// look empty whenever the server falls back to the next port.
async function dislikedApi(req, res) {
  if (req.method === 'GET') {
    fs.readFile(DISLIKED_FILE, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(err ? '[]' : data);
    });
  } else if (req.method === 'PUT') {
    const body = await readBody(req, 5 * 1024 * 1024);
    if (!Array.isArray(JSON.parse(body))) throw new Error('Expected a list');
    fs.writeFileSync(`${DISLIKED_FILE}.tmp`, body); // write-then-rename so a crash can't truncate the list
    fs.renameSync(`${DISLIKED_FILE}.tmp`, DISLIKED_FILE);
    res.writeHead(204).end();
  } else {
    res.writeHead(405).end();
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (urlPath === '/api/disliked') {
    try {
      await dislikedApi(req, res);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlPath.startsWith('/api/mu/')) {
    try {
      await proxyMangaUpdates(req, res, urlPath.slice('/api/mu/'.length));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// If the port is taken (e.g. an old `npm run dev` still running), try the next one instead of crashing.
let port = Number(PORT);
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' || port >= Number(PORT) + 10) throw err;
  console.log(`Port ${port} is busy, trying ${port + 1}…`);
  server.listen(++port);
});
server.on('listening', () => console.log(`Random Manga Generator running at http://localhost:${port}`));
server.listen(port);
