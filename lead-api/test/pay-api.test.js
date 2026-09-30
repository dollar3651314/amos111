// v6 开放 API：签名、时间戳、Idempotency-Key、IP 白名单、商户隔离（AC-P11 ③⑤），以及主要接口
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createLiteDb } from '../src/pay/db.js';
import { migrate } from '../src/pay/schema.js';
import * as core from '../src/pay/core.js';
import { createOps } from '../src/pay/ops.js';
import { createApiV1, signRequest, canonicalPath } from '../src/pay/api-v1.js';
import { derivePayKeys } from '../src/pay/common.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const keys = derivePayKeys('test-app-secret-test-app-secret-0123456789');

async function setup() {
  const db = await createLiteDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const ops = createOps({ db, keys, payBase: 'https://pay.test' });
  const mk = async (id) => { const m = await core.createMerchant(db, { id, name: id, feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } }); return { m, cred: await ops.regenerateSecret(m) }; };
  const a = await mk('ma'), b = await mk('mb');
  let ip = '203.0.113.10';
  const api = createApiV1({ db, keys, ops, getIp: () => ip });
  const call = async (cred, method, path, body, { ts = Math.floor(Date.now() / 1000), sig, idem = randomUUID(), url } = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const full = url || `https://api.test/api/v1/${path}`;
    const s = sig ?? signRequest(cred.api_secret, String(ts), method, canonicalPath(full), raw);
    const res = await api(new Request(full, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-qc-key': cred.api_key, 'x-qc-timestamp': String(ts), 'x-qc-signature': s, ...(method === 'POST' ? { 'idempotency-key': idem } : {}) } }));
    return { status: res.status, body: await res.json() };
  };
  return { db, ops, a, b, call, setIp: (v) => (ip = v) };
}

test('签名：没有签名、签名错误、时间戳过期都返回 401', async () => {
  const { a, call } = await setup();
  assert.equal((await call(a.cred, 'GET', 'balance/', null, { sig: 'deadbeef' })).status, 401);
  assert.equal((await call(a.cred, 'GET', 'balance/', null, { ts: Math.floor(Date.now() / 1000) - 400 })).body.error.code, 'timestamp_expired');
  const ok = await call(a.cred, 'GET', 'balance/');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { available: '0.00', frozen: '0.00', currency: 'USDT' });
  // 线上经过改写后的地址（/api/v1?p=balance/）和商户签名时的地址一致
  assert.equal(canonicalPath('https://x/api/v1?p=orders/&order_no=A'), '/api/v1/orders/?order_no=A');
  // vercel.json 开启了 trailingSlash，改写目标是 /api/v1/?p=...（BUG-P4：没有结尾的 / 时 Vercel 返回 404）
  assert.equal(canonicalPath('https://x/api/v1/?p=orders/&order_no=A'), '/api/v1/orders/?order_no=A');
  assert.equal((await call(a.cred, 'GET', '', null, { url: 'https://api.test/api/v1?p=balance/' })).status, 200);
});

test('订单：客户必填；Idempotency-Key 重试返回同一个订单；POST 没有 Key 返回 400', async () => {
  const { a, call } = await setup();
  const bad = await call(a.cred, 'POST', 'orders/', { merchant_order_no: 'A1', amount: '10' });
  assert.equal(bad.body.error.field, 'customer_id');
  const idem = randomUUID();
  const body = { customer_id: 'user_1', merchant_order_no: 'A1', amount: '100.5' };
  const r1 = await call(a.cred, 'POST', 'orders/', body, { idem });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.amount, '100.50');
  assert.match(r1.body.pay_url, /^https:\/\/pay\.test\/pay\/ORD-/);
  const r2 = await call(a.cred, 'POST', 'orders/', body, { idem });
  assert.equal(r2.body.order_no, r1.body.order_no);
  assert.equal((await call(a.cred, 'POST', 'orders/', { ...body, amount: '1' }, { idem })).body.error.code, 'idempotency_conflict');
  assert.equal((await call(a.cred, 'POST', 'orders/', { ...body }, {})).body.error.code, 'duplicate_merchant_order_no');
  assert.equal((await call(a.cred, 'POST', 'orders/', body, { idem: '' })).status, 400);
  const got = await call(a.cred, 'GET', `orders/?order_no=${r1.body.order_no}`);
  assert.equal(got.body.customer_id, 'user_1');
});

test('商户隔离：A 的 Key 读不到、改不了 B 的订单、客户和提币', async () => {
  const { a, b, call } = await setup();
  const o = (await call(b.cred, 'POST', 'orders/', { customer_id: 'bob', merchant_order_no: 'B1', amount: '5' })).body;
  assert.equal((await call(a.cred, 'GET', `orders/?order_no=${o.order_no}`)).status, 404);
  assert.equal((await call(a.cred, 'GET', 'customers/?customer_id=bob')).status, 404);
  assert.equal((await call(a.cred, 'GET', 'customers/list/')).body.items.length, 0);
  assert.equal((await call(a.cred, 'POST', 'orders/match/', { order_no: o.order_no, deposit_id: '1' })).status, 404);
});

test('提币：没有 IP 白名单拒绝；白名单外的 IP 拒绝；余额不够拒绝', async () => {
  const { db, ops, a, call, setIp } = await setup();
  const c = await ops.upsertCustomer(a.m, { customer_id: 'u1' });
  await core.recordDeposit(db, { txid: 'f'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 100 * U, time: new Date() });
  const body = { kind: 'payout', to: HOT, amount: '10', customer_id: 'u1' };
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', body)).body.error.code, 'ip_not_allowed');
  await ops.setIpWhitelist(a.m, ['203.0.113.10']);
  setIp('198.51.100.1');
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', body)).status, 403);
  setIp('203.0.113.10');
  const w = await call(a.cred, 'POST', 'withdrawals/', body);
  assert.equal(w.status, 200);
  assert.equal(w.body.status, 'pending');
  assert.equal(w.body.fee, '2.00');
  assert.equal((await call(a.cred, 'POST', 'withdrawals/', { ...body, amount: '100' })).body.error.code, 'insufficient_balance');
  const cancel = await call(a.cred, 'POST', 'withdrawals/cancel/', { withdrawal_no: w.body.withdrawal_no });
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal((await call(a.cred, 'GET', 'balance/')).body.available, '99.00');
});

test('客户统计、到账筛选、账本、未知接口', async () => {
  const { db, ops, a, call } = await setup();
  const c = await ops.upsertCustomer(a.m, { customer_id: 'u9', name: 'Nine', email: 'nine@example.com' });
  assert.equal((await call(a.cred, 'GET', 'customers/?customer_id=u9')).body.email, 'nine@example.com');
  const [row] = await db.query('select email_enc from customers where customer_id = $1', ['u9']);
  assert.ok(!row.email_enc.includes('nine@'), '邮箱加密保存');
  await core.recordDeposit(db, { txid: 'e'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 50 * U, time: new Date() });
  const st = (await call(a.cred, 'GET', 'customers/stats/?customer_id=u9')).body;
  assert.deepEqual([st.total, st.count, st.fees, st.unmatched], ['50.00', 1, '0.50', '50.00']);
  assert.equal((await call(a.cred, 'GET', 'deposits/?matched=false')).body.items.length, 1);
  assert.equal((await call(a.cred, 'GET', 'ledger/')).body.items.length, 2);
  assert.equal((await call(a.cred, 'GET', 'nope/')).status, 404);
});

test('vercel.json：改写到函数的目标地址以 / 结尾（trailingSlash 开启时，没有 / 会 404，BUG-P4）', async () => {
  const { readFile } = await import('node:fs/promises');
  const v = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(v.trailingSlash, true);
  for (const r of v.rewrites) assert.match(r.destination.split('?')[0], /\/$/, r.destination);
  // 改写到函数时不能用 :path* 这类命名参数：Vercel 生成的正则不接受结尾的 /（所有接口地址都以 / 结尾），
  // 而且会把参数另外加进查询串，影响签名。用 (.*)，并用 `vercel build` 生成的路由表确认过
  const v1 = v.rewrites.find((r) => r.source.startsWith('/api/v1/'));
  assert.deepEqual(v1, { source: '/api/v1/(.*)', destination: '/api/v1/?p=$1' });
  for (const u of ['/api/v1/balance/', '/api/v1/orders/ORD-1/']) assert.match(u, /^\/api\/v1(?:\/(.*))$/);
});
