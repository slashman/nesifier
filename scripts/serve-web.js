#!/usr/bin/env node
// Local preview of the web page, laid out exactly like the deployed site:
//   /            -> web/
//   /src/        -> src/
//   /vendor/     -> the jsnes browser build and its license
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const port = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain',
};
const VENDOR = {
  '/vendor/jsnes.min.js': 'node_modules/jsnes/dist/jsnes.min.js',
  '/vendor/jsnes-LICENSE.txt': 'node_modules/jsnes/LICENSE',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = VENDOR[path] ? join(root, VENDOR[path])
    : path.startsWith('/src/') ? join(root, path)
    : join(root, 'web', path === '/' ? 'index.html' : path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`nesifier web: http://localhost:${port}`));
