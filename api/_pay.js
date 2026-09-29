// v6 收付款接口的公共初始化。文件名以 _ 开头，Vercel 不会把它当作接口。
import { Redis } from '@upstash/redis';
import { ipAddress } from '@vercel/functions';
import { loadConfig } from '../lead-api/src/config.js';
import { createRawSender } from '../lead-api/src/mailer.js';
import { deriveKeys } from '../lead-api/src/kyb/crypto.js';
import { createRepo } from '../lead-api/src/kyb/repo.js';
import { createPayDeps } from '../lead-api/src/pay/deps.js';
import { approvedFromKyb } from '../lead-api/src/pay/kyb-link.js';
import { json } from '../lead-api/src/kyb/http.js';

let deps;
export function payDeps() {
  deps ??= (async () => {
    const config = loadConfig();
    if (!config.databaseUrl) throw new Error('DATABASE_URL not configured');
    if (!config.redis.url || !config.redis.token) throw new Error('storage not configured');
    const redis = new Redis({ url: config.redis.url, token: config.redis.token });
    const kybKeys = deriveKeys(config.appSecret);
    const repo = createRepo({ redis, keys: kybKeys });
    // 邮件里的链接：生产用正式地址，测试环境用 staging 分支的地址
    const host = config.appEnv === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
    return createPayDeps({
      config, kyb: { redis, keys: kybKeys, listApproved: approvedFromKyb(repo) }, send: createRawSender(config),
      getIp: (req) => ipAddress(req) || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '',
      origin: host ? `https://${host}` : '',
    });
  })().catch((err) => { deps = undefined; throw err; });
  return deps;
}

/** 初始化失败（例如还没配置数据库）时安全失败：不泄露任何配置信息 */
export async function run(fn) {
  let d;
  try { d = await payDeps(); } catch (err) { console.error(`[pay] init failed: ${err.message}`); return json(503, { error: { code: 'not_configured' } }); }
  return fn(d);
}
