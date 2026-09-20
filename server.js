/**
 * Winziger statischer Server fuer die Entwicklung.
 *
 * Die App ist reines HTML/CSS/JS ohne Build-Schritt -- sie braucht nur
 * irgendeinen Webserver, weil ES-Module ueber file:// nicht laden duerfen.
 *
 *   node server.js            -> http://localhost:8080
 *   PORT=3000 node server.js
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gpx': 'application/gpx+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Verboten');
    return;
  }

  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) throw new Error('Verzeichnis');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
  }
});

server.listen(PORT, () => {
  console.log(`Kurvenjagd läuft auf http://localhost:${PORT}`);
});
