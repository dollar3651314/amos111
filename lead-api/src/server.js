import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateLead } from './validate.js';
import { createRateLimiter } from './rateLimit.js';

const MAX_BODY = 16 * 1024;

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // 超出上限：丢弃剩余数据（不直接断开连接，保证 413 响应能送达）。
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 创建 HTTP 服务。store 和 sendMail 通过参数传入，方便单元测试替换。
 * log 默认输出到 console，同样可以替换。
 */
export function createServer({ config, store, sendMail, log = console }) {
  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });

  const clientIp = (req) =>
    (config.trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown';

  async function handleLead(req, res) {
    const ip = clientIp(req);
    if (!limiter.hit(ip)) {
      return send(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(limiter.retryAfterSec(ip)) });
    }
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, { ok: false, error: 'unsupported_media_type' });
    }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      return send(res, 413, { ok: false, error: 'too_large' }, { connection: 'close' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.status === 413) return send(res, 413, { ok: false, error: 'too_large' }, { connection: 'close' });
      return send(res, 400, { ok: false, error: 'invalid_json' });
    }
    const result = validateLead(body);
    if (!result.ok) return send(res, 400, { ok: false, error: 'validation', fields: result.errors });

    // 蜜罐字段被填写：返回假的成功结果，不保存，也不发邮件。
    if (result.honeypot) {
      log.warn?.(`[lead-api] honeypot triggered ip=${ip}`);
      return send(res, 201, { ok: true });
    }

    const lead = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      data: result.data,
    };
    try {
      store.saveLead(lead);
    } catch (err) {
      log.error(`[lead-api] failed to store lead: ${err.message}`);
      return send(res, 500, { ok: false, error: 'server_error' });
    }
    send(res, 201, { ok: true });

    // 线索已经落盘，再在后台发邮件；发送失败只记录，不影响访客。
    Promise.resolve()
      .then(() => sendMail(lead))
      .then(
        () => store.saveMailResult(lead.id, true),
        (err) => {
          log.error(`[lead-api] MAIL_FAILED id=${lead.id}: ${err.message}`);
          try {
            store.saveMailResult(lead.id, false, err.message);
          } catch (e) {
            log.error(`[lead-api] failed to record mail result: ${e.message}`);
          }
        },
      );
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
    if (url === '/api/leads') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' });
      return handleLead(req, res).catch((err) => {
        log.error(`[lead-api] unexpected error: ${err.stack || err}`);
        if (!res.headersSent) send(res, 500, { ok: false, error: 'server_error' });
      });
    }
    send(res, 404, { ok: false, error: 'not_found' });
  });
  server.on('close', () => limiter.stop());
  return server;
}
