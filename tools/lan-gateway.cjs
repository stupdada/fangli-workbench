'use strict';

const { readFileSync } = require('node:fs');
const http = require('node:http');
const { BlockList, isIPv4 } = require('node:net');
const { join } = require('node:path');

const configDir = process.argv[2];
if (!configDir) throw new Error('Usage: node tools/lan-gateway.cjs <private-config-directory>');
const { address, subnet, port, upstreamPort = 8770 } = JSON.parse(readFileSync(join(configDir, 'access.json'), 'utf8'));
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
if (!isIPv4(address) || !validPort(port) || !validPort(upstreamPort)) {
  throw new Error('Invalid LAN gateway configuration');
}
const privateAddresses = new BlockList();
privateAddresses.addSubnet('10.0.0.0', 8);
privateAddresses.addSubnet('172.16.0.0', 12);
privateAddresses.addSubnet('192.168.0.0', 16);
const [network, prefix] = String(subnet).split('/');
const peers = new BlockList();
if (!isIPv4(network) || !/^\d+$/.test(prefix || '') || Number(prefix) < 16 || Number(prefix) > 32) {
  throw new Error('Invalid LAN subnet');
}
peers.addSubnet(network, Number(prefix));
if (!privateAddresses.check(address) || !privateAddresses.check(network) || !peers.check(address)) {
  throw new Error('Bind address must be inside the private LAN subnet');
}

const host = `${address}:${port}`;
const origin = `http://${host}`;
const upstream = `127.0.0.1:${upstreamPort}`;
const maintenancePaths = new Set(['/api/workbench/shutdown', '/api/workbench/video-service/restart', '/api/workbench/geo/connection']);
const requestHeaders = ['content-type', 'content-length', 'content-disposition', 'range', 'if-range', 'if-none-match',
  'if-modified-since', 'accept', 'last-event-id'];
const responseHeaders = ['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges',
  'content-disposition', 'cache-control', 'etag', 'last-modified', 'location', 'x-content-type-options',
  'content-security-policy', 'referrer-policy'];

function reply(res, status, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(message);
}

const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 180_000 }, (req, res) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (!peers.check(req.socket.remoteAddress) || req.headers.host !== host) return reply(res, 403, 'LAN access denied');
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const requestOrigin = req.headers.origin;
  if ((requestOrigin && requestOrigin !== origin) || (!reading && requestOrigin !== origin) ||
      req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, 'Same-origin access required');
  if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, 'Invalid request path');
  let path;
  try { path = decodeURIComponent(req.url.split('?', 1)[0]); }
  catch { return reply(res, 400, 'Invalid request path'); }
  if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) {
    return reply(res, 400, 'Invalid request path');
  }
  if (path === '/api/workbench/runtime' || (!reading && maintenancePaths.has(path))) {
    return reply(res, 403, 'Use the server console for this operation');
  }
  if (req.headers['transfer-encoding']) return reply(res, 411, 'Content-Length required');

  const headers = { host: upstream, connection: 'close' };
  for (const key of requestHeaders) if (req.headers[key] !== undefined) headers[key] = req.headers[key];
  if (requestOrigin) headers.origin = `http://${upstream}`;
  const proxy = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers, agent: false }, incoming => {
    for (const key of responseHeaders) if (incoming.headers[key] !== undefined) res.setHeader(key, incoming.headers[key]);
    res.writeHead(incoming.statusCode);
    res.flushHeaders();
    incoming.on('error', () => res.destroy());
    incoming.pipe(res);
  });
  res.on('close', () => proxy.destroy());
  req.on('error', () => proxy.destroy());
  proxy.on('error', () => {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) reply(res, 502, 'Fangli workbench is unavailable on the server');
  });
  req.pipe(proxy);
});

server.listen(port, address, () => console.log(`Fangli LAN ready ${origin} (PID ${process.pid})`));
