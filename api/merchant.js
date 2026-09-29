// /api/merchant/?a=<动作>：商户后台的接口（页面 /merchant/）
import { run } from './_pay.js';
export const GET = (request) => run((d) => d.merchant(request));
export const POST = GET;
