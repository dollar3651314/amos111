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
  const cron = Boolean(c.cronSecret);
  const mailMode = c.resendApiKey ? 'resend' : c.smtp.host ? 'smtp' : 'none';
  const ok = storage && mail && secret && blob && cron;
  return json(ok ? 200 : 503, { ok, storage, mail, mailMode, secret, blob, cron });
}
