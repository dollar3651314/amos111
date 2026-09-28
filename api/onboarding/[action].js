// /api/onboarding/<动作>/：客户填写页面的接口（见 lead-api/src/kyb/onboarding.js）
import { run } from '../_kyb.js';
export const GET = (request) => run((d) => d.onboarding(request));
export const POST = (request) => run((d) => d.onboarding(request));
