import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { createFileStore } from '../src/store.js';

let server, base, store, dir, sent, mailFails;
const quietLog = { error() {}, warn() {} };

const lead = (extra = {}) => ({
  name: 'Jane', company: 'Acme', email: 'jane@acme.com', country: 'Vietnam',
  industry: 'export', consent: true, ...extra,
});

async function start(configOverrides = {}) {
  dir = mkdtempSync(join(tmpdir(), 'leadapi-'));
  store = createFileStore(dir);
  sent = [];
  mailFails = false;
  const config = { rateLimitMax: 5, rateLimitWindowMs: 60_000, trustProxy: true, ...configOverrides };
  server = createServer({
    config, store, log: quietLog,
    sendMail: async (l) => {
      if (mailFails) throw new Error('smtp down');
      sent.push(l);
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const post = (body, headers = {}) =>
  fetch(`${base}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => start());
afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('health 接口', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('合法提交：返回 201、保存 1 条线索、发送 1 封邮件、记录发送结果', async () => {
  const r = await post(lead());
  assert.equal(r.status, 201);
  await settle();
  const recs = store.readAll();
  assert.equal(recs.filter((x) => x.type === 'lead').length, 1);
  assert.equal(recs.find((x) => x.type === 'lead').data.company, 'Acme');
  assert.equal(sent.length, 1);
  assert.ok(recs.find((x) => x.type === 'mail' && x.ok));
});

test('数据文件权限为 600', async () => {
  await post(lead());
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
});

test('校验失败返回 400 和字段错误，且不保存', async () => {
  const r = await post({ name: 'x' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.fields.email, 'required');
  assert.equal(store.readAll().length, 0);
});

test('非 JSON 格式返回 415，JSON 解析失败返回 400，请求体过大返回 413', async () => {
  assert.equal((await post('a=b', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('{bad')).status, 400);
  assert.equal((await post(JSON.stringify({ message: 'x'.repeat(20000) }))).status, 413);
});

test('蜜罐：返回 201，但不保存也不发邮件', async () => {
  const r = await post(lead({ website: 'spam.example' }));
  assert.equal(r.status, 201);
  await settle();
  assert.equal(store.readAll().length, 0);
  assert.equal(sent.length, 0);
});

test('限流：同一 IP 第 6 次请求返回 429，其他 IP 不受影响', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post(lead(), { 'x-real-ip': '1.1.1.1' })).status, 201);
  const r = await post(lead(), { 'x-real-ip': '1.1.1.1' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await post(lead(), { 'x-real-ip': '2.2.2.2' })).status, 201);
});

test('邮件发送失败：仍返回 201，线索保留，并记录 ok=false', async () => {
  mailFails = true;
  const r = await post(lead());
  assert.equal(r.status, 201);
  await settle();
  const recs = store.readAll();
  assert.equal(recs.filter((x) => x.type === 'lead').length, 1);
  const m = recs.find((x) => x.type === 'mail');
  assert.equal(m.ok, false);
  assert.match(m.error, /smtp down/);
});

test('不支持的请求方法和路径', async () => {
  assert.equal((await fetch(`${base}/api/leads`)).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
