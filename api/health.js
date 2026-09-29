// GET /api/health：供外部拨测使用；同时检查存储的配置是否齐全（不返回任何配置值）。
import { loadConfig } from '../lead-api/src/config.js';
import { json } from './_lib.js';

export function GET() {
  const c = loadConfig();
  const storage = Boolean(c.redis.url && c.redis.token);
  const mail = Boolean(c.mailFrom && c.mailTo && (c.resendApiKey || c.smtp.host));
  // v3：开户所需的主密钥、私有文件存储、清理任务口令（只返回是否已配置，不返回值）
  const secret = c.appSecret.length >= 32;
  const blob = c.blobConfigured;
  const blobUpload = c.blobUploadToken; // 浏览器直传文件所需
  // 测试环境没有定时任务（Vercel Cron 只在生产运行），不要求 CRON_SECRET
  const cron = Boolean(c.cronSecret) || c.appEnv === 'staging';
  const mailMode = c.resendApiKey ? 'resend' : c.smtp.host ? 'smtp' : 'none';
  const ok = storage && mail && secret && blob && blobUpload && cron;
  // commit：当前部署的提交（前 7 位，仓库是公开的，不算敏感信息），测试环境的自动检查用它确认新版本已经部署
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
  // v6 收付款：只返回是否已配置。还没配置数据库时不影响 ok（开户和官网照常运行）；配置了数据库，其余几项也必须齐全
  const pay = { db: Boolean(c.databaseUrl), tron: c.tronNetwork, trongridKey: Boolean(c.tronApiKey), tick: Boolean(c.tickSecret) };
  const payOk = !pay.db || (pay.trongridKey && pay.tick);
  return json(ok && payOk ? 200 : 503, { ok: ok && payOk, env: c.appEnv, commit, storage, mail, mailMode, secret, blob, blobUpload, cron, pay });
}
