// 本地服务器：模拟 Vercel 的行为，用于本地开发和端到端测试。
//  - 提供 site/dist 下的静态文件（带尾斜杠的目录地址、404.html、vercel.json 中的响应头）
//  - /api/leads、/api/health 使用与生产相同的 handler，但存储换成本地文件、限流换成内存版
//  - 和 Vercel 平台一样：用 TCP 连接的真实地址覆盖 x-real-ip 请求头，访客无法伪造
// 用法：PORT=8080 DATA_DIR=./data node lead-api/src/local-server.js
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createFileStore } from './store.js';
import { createMemoryLimiter } from './rateLimit.js';
import { createMailSender } from './mailer.js';
import { createLeadHandler } from './handler.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = resolve(process.env.SITE_DIR || join(ROOT, 'site/dist'));
const PORT = Number(process.env.PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };

// 按 vercel.json 的 headers 规则计算响应头（只支持本项目用到的写法："/(.*)" 形式的通配和 host 条件）
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const rules = (vercel.headers || []).map((r) => ({
  re: new RegExp('^' + r.source.replace(/\(\.\*\)/g, '.*') + '$'),
  host: r.has?.find((h) => h.type === 'host')?.value,
  headers: r.headers,
}));
function headersFor(path, host) {
  const out = {};
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (r.host && (host || '').split(':')[0] !== r.host) continue;
    for (const h of r.headers) out[h.key] = h.value;
  }
  return out;
}

const config = loadConfig();
const handle = createLeadHandler({
  store: createFileStore(process.env.DATA_DIR || join(ROOT, 'lead-api/data')),
  limiter: createMemoryLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs }),
  sendMail: createMailSender(config),
  getIp: (req) => req.headers.get('x-real-ip'),
});

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('x-real-ip', req.socket.remoteAddress.replace(/^::ffff:/, ''));
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
}

async function sendResponse(res, response, extra) {
  const headers = { ...extra };
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = decodeURIComponent(url.pathname);
    const extra = headersFor(path, req.headers.host);
    try {
      if (path === '/api/leads') {
        if (req.method !== 'POST') return sendResponse(res, new Response(null, { status: 405, headers: { allow: 'POST' } }), extra);
        return sendResponse(res, await handle(await toRequest(req)), extra);
      }
      if (path === '/api/health') return sendResponse(res, Response.json({ ok: true }), extra);

      let file = join(SITE, path);
      if (!file.startsWith(SITE)) throw new Error('bad path');
      if (existsSync(file) && statSync(file).isDirectory()) {
        if (!path.endsWith('/')) return sendResponse(res, new Response(null, { status: 308, headers: { location: path + '/' } }), extra);
        file = join(file, 'index.html');
      }
      if (existsSync(file) && statSync(file).isFile()) {
        return sendResponse(res, new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } }), extra);
      }
      const nf = join(SITE, '404.html');
      return sendResponse(res, new Response(existsSync(nf) ? readFileSync(nf) : 'Not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }), extra);
    } catch (err) {
      console.error(err);
      res.writeHead(500).end();
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[local] http://127.0.0.1:${PORT} (site: ${SITE})`));
