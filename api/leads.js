// POST /api/leads：预约演示表单的提交接口（Vercel Function，Web 标准写法）。
// 没有导出的请求方法（GET 等），Vercel 会自动返回 405。
import { getLeadHandler, json } from './_lib.js';

export async function POST(request) {
  try {
    const handle = await getLeadHandler();
    return await handle(request);
  } catch (err) {
    console.error(`[lead-api] ${err.message}`);
    return json(500, { ok: false, error: 'server_error' });
  }
}
