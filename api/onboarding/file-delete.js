// /api/onboarding/file-delete/ → lead-api/src/kyb/onboarding.js 的 "file-delete" 动作（由 lead-api/scripts/gen-api-entries.mjs 生成）
import { run } from '../_kyb.js';
export const GET = (request) => run((d) => d.onboarding(request));
export const POST = GET;
