// 补发邮件：找出所有没有成功发送记录的线索，重新发送。
// 用法：在 lead-api 目录下，带上与服务相同的环境变量运行
//   node scripts/resend-failed.js
import { loadConfig } from '../src/config.js';
import { createFileStore } from '../src/store.js';
import { createSmtpSender } from '../src/mailer.js';

const config = loadConfig();
const store = createFileStore(config.dataDir);
const send = createSmtpSender(config);

const records = store.readAll();
const delivered = new Set(records.filter((r) => r.type === 'mail' && r.ok).map((r) => r.id));
const pending = records.filter((r) => r.type === 'lead' && !delivered.has(r.id));

console.log(`${pending.length} lead(s) without a successful email`);
let failed = 0;
for (const lead of pending) {
  try {
    await send(lead);
    store.saveMailResult(lead.id, true);
    console.log(`sent ${lead.id}`);
  } catch (err) {
    failed++;
    store.saveMailResult(lead.id, false, err.message);
    console.error(`failed ${lead.id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
