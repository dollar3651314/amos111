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
import { createRawSender } from './mailer.js';
import { createMemRedis } from './kyb/memredis.js';
import { deriveKeys } from './kyb/crypto.js';
import { createRepo } from './kyb/repo.js';
import { createLocalBlobs } from './kyb/blobs.js';
import { createOnboardingHandler } from './kyb/onboarding.js';
import { createAdminHandler, createCleanup } from './kyb/admin.js';

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
const DATA = process.env.DATA_DIR || join(ROOT, 'lead-api/data');
const leadStore = createFileStore(DATA);
const handle = createLeadHandler({
  store: leadStore,
  limiter: createMemoryLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs }),
  sendMail: createMailSender(config),
  getIp: (req) => req.headers.get('x-real-ip'),
});

// v3 开户（KYB）：Redis 用本地替身（持久化到 DATA_DIR/kyb-redis.json），文件存储用本地目录。
// 官网线索也同步写一份到 Redis 替身里，让后台的"官网线索"列表可以读到（生产环境两者本来就在同一个 Redis）。
const kybRedis = createMemRedis({ file: join(DATA, 'kyb-redis.json') });
const _saveLead = leadStore.saveLead;
leadStore.saveLead = async (lead) => { await _saveLead(lead); await kybRedis.rpush('qc:leads', JSON.stringify({ type: 'lead', ...lead })); };
const kybKeys = deriveKeys(process.env.APP_SECRET || 'local-dev-secret-local-dev-secret-0123456789');
const kybBlobs = createLocalBlobs(process.env.LOCAL_BLOB_DIR || join(DATA, 'blobs'));
const kybRepo = createRepo({ redis: kybRedis, keys: kybKeys });
const kybSend = createRawSender(config);
const kybConfig = { ...config, adminSetupToken: process.env.ADMIN_SETUP_TOKEN || '' };
const kybOnboarding = createOnboardingHandler({ repo: kybRepo, blobs: kybBlobs, send: kybSend, config: kybConfig, getIp: (req) => req.headers.get('x-real-ip') });
const kybAdmin = createAdminHandler({ repo: kybRepo, blobs: kybBlobs, send: kybSend, redis: kybRedis, keys: kybKeys, config: kybConfig });
const kybCleanup = createCleanup({ repo: kybRepo, blobs: kybBlobs });

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
      // 与 Vercel 的 trailingSlash: true 一致：没有尾斜杠、也没有扩展名的地址，一律 308 跳转到带斜杠的地址（包括 /api）
      if (!path.endsWith('/') && !extname(path)) {
        return sendResponse(res, new Response(null, { status: 308, headers: { location: path + '/' + url.search } }), extra);
      }
      if (path === '/api/leads/') {
        if (req.method !== 'POST') return sendResponse(res, new Response(null, { status: 405, headers: { allow: 'POST' } }), extra);
        return sendResponse(res, await handle(await toRequest(req)), extra);
      }
      // 与生产环境一致：开户接口只有 /api/kyb/?g=<分组>&a=<动作> 一个入口（api/kyb.js）
      if (path === '/api/kyb/') {
        const g = url.searchParams.get('g');
        const h = g === 'admin' ? kybAdmin : g === 'onboarding' ? kybOnboarding : null;
        return sendResponse(res, h ? await h(await toRequest(req)) : Response.json({ ok: false, error: 'not_found' }, { status: 404 }), extra);
      }
      if (path === '/api/cron/cleanup/') {
        const ok = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
        return sendResponse(res, ok ? Response.json({ ok: true, ...(await kybCleanup()) }) : Response.json({ ok: false }, { status: 401 }), extra);
      }
      if (path === '/api/health/') return sendResponse(res, Response.json({ ok: true }), extra);
      // api/ 下没有对应文件的地址，Vercel 返回 404；这里同样返回 404，避免本地能用、线上找不到（BUG-K7）
      if (path.startsWith('/api/')) return sendResponse(res, new Response('NOT_FOUND', { status: 404 }), extra);

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
