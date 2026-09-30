// /api/cron/cleanup/：每日清理任务（vercel.json 的 crons 调用）。Vercel 会自动带上 Authorization: Bearer <CRON_SECRET>
import { run } from '../_kyb.js';
import { json } from '../../lead-api/src/kyb/http.js';
import { safeEqual } from '../../lead-api/src/kyb/crypto.js';
import { payDeps } from '../_pay.js';

export const GET = (request) => run(async (d) => {
  const auth = request.headers.get('authorization') || '';
  if (!d.config.cronSecret || !safeEqual(auth, `Bearer ${d.config.cronSecret}`)) return json(401, { ok: false, error: 'unauthorized' });
  const kyb = await d.cleanup();
  // v6：收付款的每日任务（对账、资产检查、提醒）。还没配置数据库时跳过，不影响开户的清理
  let pay = null;
  if (d.config.databaseUrl) { try { pay = await (await payDeps()).daily(); } catch (e) { console.error(`[pay] daily: ${e.message}`); pay = { error: 'failed' }; } }
  return json(200, { ok: true, ...kyb, pay });
});
