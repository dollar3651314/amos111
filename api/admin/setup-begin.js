// /api/admin/setup-begin/ → lead-api/src/kyb/admin.js 的 "setup-begin" 动作（由 lead-api/scripts/gen-api-entries.mjs 生成）
import { run } from '../_kyb.js';
export const GET = (request) => run((d) => d.admin(request));
export const POST = GET;
