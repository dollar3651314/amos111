// /api/kyb/?g=<admin|onboarding>&a=<动作>：开户（KYB）的全部接口，合并为一个 Vercel Function。
// 原因（BUG-K8）：每个动作一个函数时，一次部署有 24 个函数，超过了 Vercel 对每次部署的函数数量限制，部署失败；
// [action].js 这种动态文件名在本项目里也不生效（BUG-K7）。处理逻辑见 lead-api/src/kyb/admin.js、onboarding.js。
import { run } from './_kyb.js';
import { json } from '../lead-api/src/kyb/http.js';

export const GET = (request) => run((d) => {
  const g = new URL(request.url).searchParams.get('g');
  if (g === 'admin') return d.admin(request);
  if (g === 'onboarding') return d.onboarding(request);
  return json(404, { ok: false, error: 'not_found' });
});
export const POST = GET;
