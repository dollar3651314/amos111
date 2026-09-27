// Vercel Functions 的公共初始化代码。文件名以 _ 开头，Vercel 不会把它当作一个接口。
import { Redis } from '@upstash/redis';
import { waitUntil, ipAddress } from '@vercel/functions';
import { loadConfig } from '../lead-api/src/config.js';
import { createRedisStore } from '../lead-api/src/store.js';
import { createUpstashLimiter } from '../lead-api/src/rateLimit.js';
import { createMailSender } from '../lead-api/src/mailer.js';
import { createLeadHandler } from '../lead-api/src/handler.js';

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

let cached;
/** 同一个函数实例内复用初始化结果（Redis 客户端、限流器）。 */
export function getLeadHandler() {
  cached ??= (async () => {
    const config = loadConfig();
    if (!config.redis.url || !config.redis.token) {
      throw new Error('storage not configured: set KV_REST_API_URL / KV_REST_API_TOKEN (Upstash integration)');
    }
    const redis = new Redis({ url: config.redis.url, token: config.redis.token });
    return createLeadHandler({
      store: createRedisStore(redis),
      limiter: await createUpstashLimiter({ redis, max: config.rateLimitMax, windowMs: config.rateLimitWindowMs }),
      sendMail: createMailSender(config),
      waitUntil,
      getIp: (req) => ipAddress(req) || req.headers.get('x-forwarded-for')?.split(',')[0].trim(),
    });
  })().catch((err) => {
    cached = undefined; // 初始化失败时不缓存，下一次请求会重试
    throw err;
  });
  return cached;
}
