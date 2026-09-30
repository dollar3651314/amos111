// /api/pay/?o=<订单号>：付款页面查询订单状态（付款方不需要登录）
import { run } from './_pay.js';
export const GET = (request) => run((d) => d.pay(request));
