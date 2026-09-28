// /api/cron/cleanup/：每日清理任务（vercel.json 的 crons 调用）。Vercel 会自动带上 Authorization: Bearer <CRON_SECRET>
import { run } from '../_kyb.js';
import { json } from '../../lead-api/src/kyb/http.js';
import { safeEqual } from '../../lead-api/src/kyb/crypto.js';

export const GET = (request) => run(async (d) => {
  const auth = request.headers.get('authorization') || '';
  if (!d.config.cronSecret || !safeEqual(auth, `Bearer ${d.config.cronSecret}`)) return json(401, { ok: false, error: 'unauthorized' });
  return json(200, { ok: true, ...(await d.cleanup()) });
});
