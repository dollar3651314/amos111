// 生成 api/admin/<动作>.js 和 api/onboarding/<动作>.js。
// 原因：Vercel 在本项目（非 Next.js、trailingSlash）里不识别 [action].js 这种动态文件名（v3 上线时返回 404，BUG-K7），
// 所以每个动作一个固定文件名的入口。新增或删除动作后运行：node lead-api/scripts/gen-api-entries.mjs
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createAdminHandler } from '../src/kyb/admin.js';
import { createOnboardingHandler } from '../src/kyb/onboarding.js';

export const GROUPS = {
  admin: createAdminHandler({ repo: {}, redis: {}, keys: {}, config: {} }).actions,
  onboarding: createOnboardingHandler({ repo: {}, config: {} }).actions,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [group, actions] of Object.entries(GROUPS)) {
    const dir = new URL(`../../api/${group}/`, import.meta.url);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const a of actions) {
      writeFileSync(new URL(`${a}.js`, dir),
        `// /api/${group}/${a}/ → lead-api/src/kyb/${group}.js 的 "${a}" 动作（由 lead-api/scripts/gen-api-entries.mjs 生成）\n` +
        `import { run } from '../_kyb.js';\n` +
        `export const GET = (request) => run((d) => d.${group}(request));\n` +
        `export const POST = GET;\n`);
    }
    console.log(group, actions.join(' '));
  }
}
