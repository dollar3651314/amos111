// /api/wallet/?a=<动作>：运营后台的收付款接口（只有 Amos 能用）
import { run } from './_pay.js';
export const GET = (request) => run((d) => d.wallet(request));
export const POST = GET;
