// 补发邮件：找出所有没有成功发送记录的线索，重新发送。
// 用法（在仓库根目录执行）：
//   1. vercel env pull .env.production --environment=production   # 拉取生产环境变量到本地（此文件不会提交到仓库）
//   2. node --env-file=.env.production lead-api/scripts/resend-failed.js
import { Redis } from '@upstash/redis';
import { loadConfig } from '../src/config.js';
import { createRedisStore } from '../src/store.js';
import { createMailSender } from '../src/mailer.js';

const config = loadConfig();
const store = createRedisStore(new Redis({ url: config.redis.url, token: config.redis.token }));
const send = createMailSender(config);

const records = await store.readAll();
const delivered = new Set(records.filter((r) => r.type === 'mail' && r.ok).map((r) => r.id));
const pending = records.filter((r) => r.type === 'lead' && !delivered.has(r.id));
console.log(`${pending.length} lead(s) without a successful email`);
let failed = 0;
for (const lead of pending) {
  try {
    await send(lead);
    await store.saveMailResult(lead.id, true);
    console.log(`sent ${lead.id}`);
  } catch (err) {
    failed++;
    await store.saveMailResult(lead.id, false, err.message);
    console.error(`failed ${lead.id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
