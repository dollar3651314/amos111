// v6 开放 API：/api/v1/<路径>（开发者文档 /docs/）。
// 每个请求都要签名：X-QC-Key、X-QC-Timestamp、X-QC-Signature = hex(HMAC-SHA256(Secret, 时间戳\n方法\n路径和查询\nhex(SHA-256(请求体))))。
// POST 请求必须带 Idempotency-Key：同一个 Key 重试返回第一次的结果，签名被截获后重放也不会重复创建订单或提币。
import { createHash, createHmac } from 'node:crypto';
import { json } from '../kyb/http.js';
import { decryptJson, safeEqual } from '../kyb/crypto.js';
import { PayError } from './core.js';
import { money, errorResponse, limitOf } from './common.js';

const MAX_SKEW_S = 300;
const MAX_BODY = 32 * 1024;

/** 商户签名时用的路径：/api/v1/<路径>?<查询>。线上经过改写后路径在 p 参数里，这里还原成商户请求时的样子 */
export function canonicalPath(url) {
  const u = new URL(url);
  const p = u.searchParams.get('p');
  if (p === null) return u.pathname + u.search;
  const rest = new URLSearchParams(u.search);
  rest.delete('p');
  const qs = rest.toString();
  return `/api/v1/${p.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
}
export function signRequest(secret, ts, method, path, body) {
  const bodyHash = createHash('sha256').update(body || '').digest('hex');
  return createHmac('sha256', secret).update([ts, method, path, bodyHash].join('\n')).digest('hex');
}

// 每个 API Key 每秒最多 20 个请求（同一个函数实例内计数；迁移到云服务器后改为集中限流）
const buckets = new Map();
function allow(key, now) {
  const b = buckets.get(key) || { t: now, n: 0 };
  if (now - b.t >= 1000) { b.t = now; b.n = 0; }
  b.n++; buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n <= 20;
}

export function createApiV1({ db, keys, ops, getIp = () => '', now = () => Date.now() }) {
  async function auth(request, raw) {
    const key = request.headers.get('x-qc-key') || '';
    const ts = request.headers.get('x-qc-timestamp') || '';
    const sig = request.headers.get('x-qc-signature') || '';
    if (!key || !ts || !sig) throw new PayError('invalid_signature', 401);
    if (!/^\d{9,11}$/.test(ts) || Math.abs(now() / 1000 - Number(ts)) > MAX_SKEW_S) throw new PayError('timestamp_expired', 401);
    const [m] = await db.query('select m.*, b.available, b.frozen from merchants m join balances b on b.merchant_id = m.id where m.api_key = $1', [key]);
    if (!m || !m.api_secret_enc) throw new PayError('invalid_signature', 401);
    const secret = decryptJson(keys.enc, m.api_secret_enc);
    if (!safeEqual(signRequest(secret, ts, request.method, canonicalPath(request.url), raw), sig.toLowerCase())) throw new PayError('invalid_signature', 401);
    if (m.status !== 'active') throw new PayError('merchant_disabled', 403);
    if (!allow(key, now())) throw new PayError('rate_limited', 429);
    return m;
  }
  /** 同一个 Idempotency-Key：请求内容相同就返回第一次的结果，不同就返回 409 */
  async function idempotent(m, request, raw, fn) {
    const key = request.headers.get('idempotency-key') || '';
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) throw new PayError('idempotency_key_required', 400);
    const h = createHash('sha256').update(`${canonicalPath(request.url)}\n${raw}`).digest('hex');
    // 先占住这个 Key：两个相同的请求同时到达时，只有一个会执行
    const [claimed] = await db.query(`insert into idempotency (merchant_id, key, request_hash, response) values ($1, $2, $3, '{"pending": true}'::jsonb)
      on conflict do nothing returning key`, [m.id, key, h]);
    if (!claimed) {
      const [prev] = await db.query('select request_hash, response from idempotency where merchant_id = $1 and key = $2', [m.id, key]);
      if (!prev || prev.request_hash !== h) throw new PayError('idempotency_conflict', 409);
      if (prev.response?.pending) throw new PayError('request_in_progress', 409);
      return prev.response;
    }
    try {
      const out = await fn();
      await db.query('update idempotency set response = $3::jsonb where merchant_id = $1 and key = $2', [m.id, key, JSON.stringify(out)]);
      return out;
    } catch (e) {
      // 失败的请求不占用这个 Key，商户可以修正后用同一个 Key 重试
      await db.query('delete from idempotency where merchant_id = $1 and key = $2', [m.id, key]);
      throw e;
    }
  }
  const needIp = (m, request) => {
    const ip = getIp(request);
    if (!m.ip_whitelist.length || !m.ip_whitelist.includes(ip)) throw new PayError('ip_not_allowed', 403);
  };

  const routes = {
    'GET orders': (m, q) => ops.getOrder(m, { orderNo: q.get('order_no'), merchantOrderNo: q.get('merchant_order_no') }),
    'GET orders/list': (m, q) => ops.listOrders(m, { status: q.get('status') || '', customerId: q.get('customer_id') || '', cursor: q.get('cursor'), limit: limitOf(q) }),
    'POST orders': (m, q, b) => ops.createOrder(m, b),
    'POST orders/match': (m, q, b) => ops.match(m, b, `api:${m.id}`, true),
    'POST orders/unmatch': (m, q, b) => ops.match(m, b, `api:${m.id}`, false),
    'POST customers': (m, q, b) => ops.upsertCustomer(m, b),
    'GET customers': (m, q) => ops.getCustomer(m, q.get('customer_id') || ''),
    'GET customers/list': (m, q) => ops.listCustomers(m, { q: q.get('q') || '', cursor: q.get('cursor'), limit: limitOf(q) }),
    'GET customers/stats': (m, q) => ops.customerStats(m, q.get('customer_id') || '', { from: q.get('from'), to: q.get('to') }),
    'GET balance': (m) => ops.balance(m),
    'GET ledger': (m, q) => ops.ledger(m, { cursor: q.get('cursor'), limit: limitOf(q), customerId: q.get('customer_id') || '' }),
    'GET deposits': (m, q) => ops.deposits(m, { cursor: q.get('cursor'), limit: limitOf(q), customerId: q.get('customer_id') || '', matched: q.get('matched') || '' }),
    'POST withdrawals': (m, q, b, request) => { needIp(m, request); return ops.withdraw(m, b, 'api'); },
    'GET withdrawals': (m, q) => ops.getWithdrawal(m, q.get('withdrawal_no')),
    'POST withdrawals/cancel': (m, q, b) => ops.cancelWithdrawal(m, b.withdrawal_no),
  };

  return async function handle(request) {
    try {
      const path = canonicalPath(request.url).split('?')[0].replace(/^\/api\/v1\/?/, '').replace(/\/+$/, '');
      const route = routes[`${request.method} ${path}`];
      if (!route) return json(404, { error: { code: 'not_found', message: 'Unknown endpoint' } });
      const raw = request.method === 'POST' ? await request.text() : '';
      if (raw.length > MAX_BODY) return json(413, { error: { code: 'too_large', message: 'Request body too large' } });
      const m = await auth(request, raw);
      let body = {};
      if (request.method === 'POST') { try { body = JSON.parse(raw || '{}'); } catch { throw new PayError('invalid_param', 400, 'body'); } }
      const q = new URL(request.url).searchParams;
      const run = () => route(m, q, body, request);
      const out = request.method === 'POST' ? await idempotent(m, request, raw, run) : await run();
      return json(200, money(out));
    } catch (e) { return errorResponse(e); }
  };
}
