// /api/tick/：每分钟任务，由 cron-job.org 调用（请求头 Authorization: Bearer <TICK_SECRET>）。
import { run } from './_pay.js';
import { loadConfig } from '../lead-api/src/config.js';
import { json } from '../lead-api/src/kyb/http.js';
import { safeEqual } from '../lead-api/src/kyb/crypto.js';

export const maxDuration = 30;
export const GET = (request) => {
  const secret = loadConfig().tickSecret;
  if (!secret || !safeEqual(request.headers.get('authorization') || '', `Bearer ${secret}`)) return json(401, { ok: false, error: 'unauthorized' });
  return run(async (d) => json(200, { ok: true, ...(await d.tick()) }));
};
export const POST = GET;
