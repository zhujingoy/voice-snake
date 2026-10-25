const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.gz': 'application/gzip', '.svg': 'image/svg+xml' };
const routes = require('./assets.cjs');
const { SESSION_PATH, readConfig, createSessionBroker } = require('./lingxi-session.cjs');
const lingxiConfig = readConfig();
const handleLingxiSession = createSessionBroker({ config: lingxiConfig });
let port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65525) throw new Error('PORT must be between 1024 and 65525');
const server = http.createServer((request, response) => {
  if (request.url === SESSION_PATH) { void handleLingxiSession(request, response); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  let route;
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (Object.hasOwn(routes, pathname)) route = routes[pathname];
  } catch {}
  if (!route) { response.writeHead(404); response.end('Not found'); return; }
  fs.readFile(path.join(root, route), (error, data) => {
    if (error) { response.writeHead(500); response.end('Unable to load asset'); return; }
    response.writeHead(200, {
      'Content-Type': types[path.extname(route)], 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: ${lingxiConfig?.socketOrigin || ''}; media-src 'self' blob:; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  });
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && port < 65535) {
    port += 1;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});
server.on('listening', () => console.log(`Voice Snake: http://localhost:${port}`));
server.listen(port, '127.0.0.1');
