// /api/tick/：每分钟任务，由 cron-job.org 调用（请求头 Authorization: Bearer <TICK_SECRET>）。
import { run } from './_pay.js';
import { loadConfig } from '../lead-api/src/config.js';
import { json } from '../lead-api/src/kyb/http.js';
import { safeEqual } from '../lead-api/src/kyb/crypto.js';

export const maxDuration = 30;
export const GET = (request) => {
  // ?health=1：公开的"链上监控是否在运行"（只返回距离上次运行的秒数），GitHub Actions 每 15 分钟检查一次
  if (new URL(request.url).searchParams.get('health') === '1') {
    return run(async (d) => {
      const [r] = await d.db.query(`select value from pay_meta where key = 'tick_last'`);
      const age = r ? Math.round((Date.now() - Date.parse(r.value.at)) / 1000) : null;
      return json(age !== null && age <= 300 ? 200 : 503, { ok: age !== null && age <= 300, age_s: age });
    });
  }
  const secret = loadConfig().tickSecret;
  if (!secret || !safeEqual(request.headers.get('authorization') || '', `Bearer ${secret}`)) return json(401, { ok: false, error: 'unauthorized' });
  return run(async (d) => json(200, { ok: true, ...(await d.tick()) }));
};
export const POST = GET;
