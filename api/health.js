// GET /api/health：供外部拨测使用；同时检查存储的配置是否齐全（不返回任何配置值）。
import { loadConfig } from '../lead-api/src/config.js';
import { json } from './_lib.js';

export function GET() {
  const c = loadConfig();
  const storage = Boolean(c.redis.url && c.redis.token);
  const mail = Boolean(c.mailFrom && c.mailTo && (c.resendApiKey || c.smtp.host));
  return json(storage && mail ? 200 : 503, { ok: storage && mail, storage, mail });
}
