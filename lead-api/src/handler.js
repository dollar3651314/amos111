import { randomUUID } from 'node:crypto';
import { validateLead } from './validate.js';

const MAX_BODY = 16 * 1024;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

/**
 * 表单接口 POST /api/leads 的处理函数，使用 Web 标准的 Request/Response。
 * 依赖通过参数传入，这样 Vercel Function、本地服务器和单元测试可以共用同一份逻辑：
 *   store      线索存储（见 store.js）
 *   limiter    限流器（见 rateLimit.js）
 *   sendMail   发信函数（见 mailer.js）
 *   waitUntil  在响应返回之后继续执行后台任务（Vercel 上使用 @vercel/functions 提供的版本）
 *   getIp      从请求中取访客 IP
 */
export function createLeadHandler({ store, limiter, sendMail, waitUntil = (p) => p, getIp, log = console }) {
  return async function handle(request) {
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' });

    const ip = getIp(request) || 'unknown';
    const rl = await limiter.limit(ip);
    if (!rl.success) {
      const retry = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return json(429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(retry) });
    }
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return json(415, { ok: false, error: 'unsupported_media_type' });
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY) return json(413, { ok: false, error: 'too_large' });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY) return json(413, { ok: false, error: 'too_large' });

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: 'invalid_json' });
    }
    const result = validateLead(body);
    if (!result.ok) return json(400, { ok: false, error: 'validation', fields: result.errors });

    // 蜜罐字段被填写：返回假的成功结果，不保存，也不发邮件
    if (result.honeypot) {
      log.warn?.(`[lead-api] honeypot triggered ip=${ip}`);
      return json(201, { ok: true });
    }

    const lead = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      ip,
      userAgent: String(request.headers.get('user-agent') || '').slice(0, 300),
      data: result.data,
    };
    try {
      await store.saveLead(lead);
    } catch (err) {
      log.error(`[lead-api] failed to store lead: ${err.message}`);
      return json(500, { ok: false, error: 'server_error' });
    }

    // 线索已经保存，再在后台发邮件；发送失败只做记录，不影响访客看到的结果
    waitUntil(
      Promise.resolve()
        .then(() => sendMail(lead))
        .then(
          () => store.saveMailResult(lead.id, true),
          async (err) => {
            log.error(`[lead-api] MAIL_FAILED id=${lead.id}: ${err.message}`);
            await store.saveMailResult(lead.id, false, err.message);
          },
        )
        .catch((e) => log.error(`[lead-api] failed to record mail result: ${e.message}`)),
    );
    return json(201, { ok: true });
  };
}
