// /api/admin/<动作>/：审核后台的接口（见 lead-api/src/kyb/admin.js）
import { run } from '../_kyb.js';
export const GET = (request) => run((d) => d.admin(request));
export const POST = (request) => run((d) => d.admin(request));
