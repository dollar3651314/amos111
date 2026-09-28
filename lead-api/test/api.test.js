import { test } from 'node:test';
import assert from 'node:assert/strict';

// Vercel 函数入口：没有配置存储时，接口返回 500、健康检查返回 503，并且不会泄露配置值
test('api/leads 和 api/health：没有配置存储时安全失败', async () => {
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'APP_SECRET', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'CRON_SECRET', 'SMTP_HOST', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_TO']) delete process.env[k];
  const origError = console.error;
  console.error = () => {};
  try {
    const { POST } = await import('../../api/leads.js');
    const r = await POST(new Request('http://x/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { ok: false, error: 'server_error' });
    const { GET } = await import('../../api/health.js');
    const h = GET();
    assert.equal(h.status, 503);
    assert.deepEqual(await h.json(), { ok: false, env: 'local', commit: '', storage: false, mail: false, mailMode: 'none', secret: false, blob: false, blobUpload: false, cron: false });
    // v3：开户接口在没有配置时返回 503，不泄露任何信息
    const ob = await import('../../api/kyb.js');
    const r2 = await ob.GET(new Request('http://x/api/kyb/?g=onboarding&a=state'));
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { ok: false, error: 'not_configured' });
  } finally {
    console.error = origError;
  }
});

test('配置：环境变量的首尾空白和换行会被去掉', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ APP_SECRET: '  abc\n', CRON_SECRET: 'x\r\n', SMTP_HOST: ' smtp.qq.com ' });
  assert.equal(c.appSecret, 'abc'); assert.equal(c.cronSecret, 'x'); assert.equal(c.smtp.host, 'smtp.qq.com');
});

test('接口入口：Vercel 函数不超过 12 个，没有 [xxx].js 动态文件名（BUG-K7、BUG-K8）', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [e.name]));
  const files = walk(new URL('../../api/', import.meta.url));
  assert.deepEqual(files.filter((n) => n.includes('[')), []);
  const functions = files.filter((n) => n.endsWith('.js') && !n.startsWith('_'));
  assert.ok(functions.length <= 12, `函数数量 ${functions.length}：${functions.join(', ')}`);
  // 同一个入口按 g 参数分发；g 不对时返回 404；没有配置时安全返回 503
  const { GET } = await import('../../api/kyb.js');
  assert.equal((await GET(new Request('https://x.test/api/kyb/?g=admin&a=me'))).status, 503);
});

test('测试环境：邮件标题带"[测试环境]"；健康检查返回 env，且不要求 CRON_SECRET（agents v0.6 C34）', async () => {
  const { envSubject, formatLeadEmail } = await import('../src/mailer.js');
  const { loadConfig } = await import('../src/config.js');
  assert.equal(envSubject(loadConfig({ APP_ENV: 'staging' }), 'Hi'), '[测试环境] Hi');
  assert.equal(envSubject(loadConfig({ VERCEL_ENV: 'production' }), 'Hi'), 'Hi');
  assert.equal(loadConfig({ VERCEL_ENV: 'preview' }).appEnv, 'preview');
  assert.ok(formatLeadEmail({ id: '1', receivedAt: 'x', data: { company: 'C' } }).subject.startsWith('[Quick Come]'));
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { APP_ENV: 'staging', KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't', MAIL_FROM: 'a@x', MAIL_TO: 'b@x', SMTP_HOST: 'smtp.x', APP_SECRET: 'x'.repeat(40), BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' });
    delete process.env.CRON_SECRET;
    const { GET } = await import('../../api/health.js?staging');
    const b = await GET().json();
    assert.equal(b.env, 'staging'); assert.equal(b.cron, true); assert.equal(b.ok, true);
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});
