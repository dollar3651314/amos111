import { test, expect } from '@playwright/test';
import { readJsonl, DATA_MAIN, DATA_RL } from '../stack.mjs';
import { resolve } from 'node:path';

const valid = { name: 'Api Tester', company: 'Api Co', email: 'api@test.com', country: 'Kenya', industry: 'export', consent: true };

// TC-17 (AC5) 绕过前端直接请求：经 Nginx 访问，服务端拒绝非法数据
test('TC-17 AC5 绕过前端直接提交非法数据被服务端拒绝', async ({ request }) => {
  const cases: [object, string][] = [
    [{ ...valid, email: 'bad' }, 'email'],
    [{ ...valid, name: '' }, 'name'],
    [{ ...valid, consent: false }, 'consent'],
    [{ ...valid, industry: 'casino' }, 'industry'],
    [{ ...valid, company: 'A\r\nBcc: evil@x.com' }, 'company'],
  ];
  const before = readJsonl(resolve(DATA_MAIN, 'leads.jsonl')).length;
  for (const [body, field] of cases) {
    const r = await request.post('/api/leads', { data: body });
    expect(r.status(), JSON.stringify(body)).toBe(400);
    expect((await r.json()).fields[field]).toBeTruthy();
  }
  expect(readJsonl(resolve(DATA_MAIN, 'leads.jsonl')).length).toBe(before);
  const r2 = await request.post('/api/leads', { headers: { 'content-type': 'text/plain' }, data: 'hello' });
  expect(r2.status()).toBe(415);
});

// TC-18 (AC7) 同一 IP 10 分钟内第 6 次提交被拒绝（默认配置的实例，端口 3002）
// v2：访客 IP 由平台层写入（与 Vercel 相同），访客自己伪造的 x-real-ip 请求头不能绕过限流
test('TC-18 AC7 同一 IP 第 6 次提交返回 429，伪造 IP 请求头也无法绕过', async ({ request }) => {
  const url = 'http://127.0.0.1:3002/api/leads';
  for (let i = 1; i <= 5; i++) {
    const r = await request.post(url, { data: valid });
    expect(r.status(), `第 ${i} 次`).toBe(201);
  }
  const r6 = await request.post(url, { data: valid });
  expect(r6.status()).toBe(429);
  expect(Number(r6.headers()['retry-after'])).toBeGreaterThan(500); // 接近 10 分钟
  const spoof = await request.post(url, { data: valid, headers: { 'x-real-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.99' } });
  expect(spoof.status(), '伪造 IP 请求头绕过了限流').toBe(429);
  expect(readJsonl(resolve(DATA_RL, 'leads.jsonl')).filter((r) => r.type === 'lead').length).toBe(5);
});

// TC-19 (AC7) 蜜罐字段被填写：返回成功但不保存
test('TC-19 AC7 触发蜜罐的提交不会被保存', async ({ request }) => {
  const file = resolve(DATA_MAIN, 'leads.jsonl');
  const before = readJsonl(file).length;
  const r = await request.post('/api/leads', { data: { ...valid, website: 'http://spam.example' } });
  expect(r.status()).toBe(201);
  await new Promise((res) => setTimeout(res, 300));
  expect(readJsonl(file).length).toBe(before);
});

// TC-20 补充：请求体大小限制（v2 由函数自身限制为 16KB）
test('TC-20 补充 超大请求体被拒绝（413）', async ({ request }) => {
  const r = await request.post('/api/leads', { data: { ...valid, message: 'x'.repeat(40 * 1024) } });
  expect(r.status()).toBe(413);
});
