// v6 收付款接口的公共初始化。文件名以 _ 开头，Vercel 不会把它当作接口。
import { Redis } from '@upstash/redis';
import { ipAddress } from '@vercel/functions';
import { loadConfig } from '../lead-api/src/config.js';
import { createRawSender } from '../lead-api/src/mailer.js';
import { deriveKeys } from '../lead-api/src/kyb/crypto.js';
import { createRepo } from '../lead-api/src/kyb/repo.js';
import { createPayDeps } from '../lead-api/src/pay/deps.js';
import { approvedFromKyb, pendingKybCount } from '../lead-api/src/pay/kyb-link.js';
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
      config, kyb: { redis, keys: kybKeys, listApproved: approvedFromKyb(repo), pendingKyb: pendingKybCount(repo) }, send: createRawSender(config),
      getIp: (req) => ipAddress(req) || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '',
      origin: host ? `https://${host}` : '',
    });
  })().catch((err) => { deps = undefined; throw err; });
  return deps;
}

/** 初始化失败（例如还没配置数据库）时安全失败：不泄露任何配置信息 */
export async function run(fn) {
  let d;
  try { d = await payDeps(); } catch (err) {
    console.error(`[pay] init failed: ${err.code || ''} ${err.message}`);
    // 测试环境多返回一个原因代码（只是类别，不含任何配置值），方便排查连接串；生产不返回
    const reason = loadConfig().appEnv === 'production' ? undefined : initReason(err);
    return json(503, { error: { code: 'not_configured', ...(reason ? { reason } : {}) } });
  }
  return fn(d);
}

/** 初始化失败的类别。没有配置数据库时返回 undefined */
export function initReason(err) {
  const m = String(err?.message || '');
  if (/DATABASE_URL not configured|storage not configured/.test(m)) return undefined;
  if (err?.code === '28P01') return 'db_auth';                        // 密码错误
  if (/tenant or user not found/i.test(m)) return 'db_user';          // 用户名错误（连接池的用户名是 postgres.项目编号）
  if (err?.code === '3D000') return 'db_name';                        // 数据库名错误
  if (err instanceof TypeError && /url/i.test(m)) return 'db_url_invalid'; // 连接串格式错误（例如密码里有 @ # / ? 等字符没有转义）
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(err?.code)) return 'db_host';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'ECONNRESET'].includes(err?.code)) return 'db_unreachable';
  if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return `db_${err.code}`;
  return 'init_failed';
}
