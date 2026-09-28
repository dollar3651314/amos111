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
    assert.deepEqual(await h.json(), { ok: false, storage: false, mail: false, mailMode: 'none', secret: false, blob: false, cron: false });
    // v3：开户接口在没有配置时返回 503，不泄露任何信息
    const ob = await import('../../api/onboarding/[action].js');
    const r2 = await ob.GET(new Request('http://x/api/onboarding/state/'));
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { ok: false, error: 'not_configured' });
  } finally {
    console.error = origError;
  }
});
