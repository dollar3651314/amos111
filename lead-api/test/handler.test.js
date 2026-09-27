import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler } from '../src/handler.js';
import { createMemoryStore, createRedisStore } from '../src/store.js';
import { createMemoryLimiter } from '../src/rateLimit.js';
import { createResendSender } from '../src/mailer.js';

const quiet = { error() {}, warn() {} };
const lead = (extra = {}) => ({
  name: 'Jane', company: 'Acme', email: 'jane@acme.com', country: 'Vietnam', industry: 'export', consent: true, ...extra,
});

function setup({ max = 5, mailFails = false } = {}) {
  const store = createMemoryStore();
  const sent = [];
  const pending = [];
  const handle = createLeadHandler({
    store,
    limiter: createMemoryLimiter({ max, windowMs: 600_000 }),
    sendMail: async (l) => {
      if (mailFails) throw new Error('smtp down');
      sent.push(l);
    },
    waitUntil: (p) => pending.push(p),
    getIp: (req) => req.headers.get('x-real-ip'),
    log: quiet,
  });
  const post = (body, headers = {}) =>
    handle(new Request('http://x/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '1.1.1.1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
  return { store, sent, post, handle, flush: () => Promise.all(pending) };
}

test('合法提交：返回 201，保存 1 条线索，通过 waitUntil 在后台发 1 封邮件并记录结果', async () => {
  const s = setup();
  const r = await s.post(lead());
  assert.equal(r.status, 201);
  await s.flush();
  assert.equal(s.store.records.filter((x) => x.type === 'lead').length, 1);
  assert.equal(s.store.records.find((x) => x.type === 'lead').ip, '1.1.1.1');
  assert.equal(s.sent.length, 1);
  assert.ok(s.store.records.find((x) => x.type === 'mail' && x.ok));
});

test('校验失败返回 400 和字段错误，且不保存', async () => {
  const s = setup();
  const r = await s.post({ name: 'x' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).fields.email, 'required');
  assert.equal(s.store.records.length, 0);
});

test('非 JSON 返回 415，JSON 解析失败返回 400，请求体过大返回 413，非 POST 返回 405', async () => {
  const s = setup({ max: 100 });
  assert.equal((await s.post('a=b', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await s.post('{bad')).status, 400);
  assert.equal((await s.post(JSON.stringify({ message: 'x'.repeat(20000) }))).status, 413);
  assert.equal((await s.handle(new Request('http://x/api/leads'))).status, 405);
});

test('蜜罐：返回 201，但不保存也不发邮件', async () => {
  const s = setup();
  assert.equal((await s.post(lead({ website: 'spam' }))).status, 201);
  await s.flush();
  assert.equal(s.store.records.length, 0);
  assert.equal(s.sent.length, 0);
});

test('限流：同一 IP 第 6 次返回 429（带 Retry-After），其他 IP 不受影响；非法请求也计数', async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.post({ bad: true })).status, 400);
  const r = await s.post(lead());
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 500);
  assert.equal((await s.post(lead(), { 'x-real-ip': '2.2.2.2' })).status, 201);
});

test('邮件发送失败：仍返回 201，线索保留，并记录 ok=false', async () => {
  const s = setup({ mailFails: true });
  assert.equal((await s.post(lead())).status, 201);
  await s.flush();
  const m = s.store.records.find((x) => x.type === 'mail');
  assert.equal(m.ok, false);
  assert.match(m.error, /smtp down/);
});

test('存储失败时返回 500', async () => {
  const handle = createLeadHandler({
    store: { saveLead: async () => { throw new Error('redis down'); } },
    limiter: createMemoryLimiter({ max: 5, windowMs: 1000 }),
    sendMail: async () => {},
    getIp: () => '1.1.1.1',
    log: quiet,
  });
  const r = await handle(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead()) }));
  assert.equal(r.status, 500);
});

test('Redis 存储：写入两个只追加的列表，readAll 能读回', async () => {
  const lists = {};
  const fake = {
    rpush: async (k, v) => (lists[k] ??= []).push(v),
    lrange: async (k) => (lists[k] || []).map((v) => JSON.parse(v)), // 模拟 @upstash/redis 的自动反序列化
  };
  const st = createRedisStore(fake);
  await st.saveLead({ id: 'a', data: { company: 'Acme' } });
  await st.saveMailResult('a', true);
  assert.equal(lists['qc:leads'].length, 1);
  assert.equal(lists['qc:mail'].length, 1);
  const all = await st.readAll();
  assert.equal(all.find((r) => r.type === 'lead').data.company, 'Acme');
  assert.equal(all.find((r) => r.type === 'mail').ok, true);
});

test('Resend 发信：请求格式正确；API 返回错误时抛出异常', async () => {
  const calls = [];
  const ok = createResendSender({ resendApiKey: 'k', mailFrom: 'a@x.com', mailTo: 'b@x.com' }, async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  });
  await ok({ id: '1', receivedAt: 't', data: { company: 'Acme', email: 'c@x.com' } });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['b@x.com']);
  assert.equal(body.reply_to, 'c@x.com');
  assert.match(body.subject, /Acme/);
  const bad = createResendSender({ resendApiKey: 'k' }, async () => new Response('nope', { status: 403 }));
  await assert.rejects(bad({ id: '1', data: { company: 'A', email: 'c@x.com' } }), /Resend 403/);
});
