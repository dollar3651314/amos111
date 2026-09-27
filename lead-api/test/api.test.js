import { test } from 'node:test';
import assert from 'node:assert/strict';

// Vercel 函数入口：没有配置存储时，接口返回 500、健康检查返回 503，并且不会泄露配置值
test('api/leads 和 api/health：没有配置存储时安全失败', async () => {
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
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
    assert.deepEqual(await h.json(), { ok: false, storage: false, mail: false });
  } finally {
    console.error = origError;
  }
});
