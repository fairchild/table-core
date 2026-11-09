// Serves docs/ at http://localhost:4321 for reading locally: ES modules don't load from file:// URLs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const docs = new URL('../docs/', import.meta.url);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const port = Number(process.env.PORT ?? 4321);
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/\/$/, '/index.html');
  const file = new URL(`.${path}`, docs);
  if (!file.href.startsWith(docs.href)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
