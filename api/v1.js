// /api/v1/<路径>：开放 API（开发者文档 /docs/）。vercel.json 把 /api/v1/<路径> 改写到这里，路径放在 p 参数里。
import { run } from './_pay.js';
export const GET = (request) => run((d) => d.v1(request));
export const POST = GET;
