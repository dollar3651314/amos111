// 《项目索引》（仓库根目录的 项目索引.md）不能过时（agents 规则 C53）：
// 从代码里读出实际的文件、接口动作、开放 API 路由、数据库表、pay_meta 的键、环境变量、后台标签，
// 逐个检查索引里有没有写；索引里写到的路径和变量也必须真实存在。新增或删除了却没有更新索引，测试就失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMerchantApi } from '../src/pay/merchant-api.js';
import { createWalletApi } from '../src/pay/wallet-api.js';
import { createApiV1 } from '../src/pay/api-v1.js';
import { createAdminHandler } from '../src/kyb/admin.js';
import { createOnboardingHandler } from '../src/kyb/onboarding.js';
import { SCHEMA } from '../src/pay/schema.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX = readFileSync(join(ROOT, '项目索引.md'), 'utf8');
const MAP = readFileSync(join(ROOT, '项目地图.md'), 'utf8');

/** 仓库里的文件（已提交的 + 新建还没提交的，不含 .gitignore 忽略的），相对仓库根目录 */
const FILES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => existsSync(join(ROOT, f)));
/** 某个目录下的文件；skip 里的子目录除外 */
const walk = (dir, skip = []) => FILES.filter((f) => f.startsWith(`${dir}/`) && !skip.some((s) => f.startsWith(`${s}/`)) && !/(^|\/)(\.gitignore|package-lock\.json)$/.test(f));
/** 反引号里的内容 */
const ticks = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
/** 按标题取一节（到下一个同级或更高级标题为止） */
function section(title) {
  const lines = INDEX.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.includes(title));
  assert.ok(start >= 0, `项目索引里找不到"${title}"这一节`);
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
/** 表格第一列里反引号中的内容 */
const firstCol = (text) => text.split('\n').filter((l) => l.startsWith('| `')).map((l) => l.split('|')[1]).flatMap(ticks);

test('项目索引：代码和配置的每个文件都写进了索引，索引里写到的路径都存在', () => {
  const files = [
    ...walk('api'), ...walk('lead-api/src'), ...walk('lead-api/scripts'), ...walk('lead-api/test'),
    ...walk('site/src'), ...walk('site/scripts'), ...walk('site/brand-src'), ...walk('e2e', ['e2e/tests']), ...walk('e2e/tests'),
    ...walk('config'), ...walk('.github/workflows'),
    'package.json', 'vercel.json', 'lead-api/.env.example', 'site/package.json', 'site/astro.config.mjs',
    // 文档：根目录和各文档目录下的每一份
    ...readdirSync(ROOT).filter((f) => f.endsWith('.md')),
    ...['需求文档', '技术方案', '测试报告', '部署方案', '交付记录'].flatMap((d) => walk(d)),
  ];
  const written = new Set(ticks(INDEX));
  const missing = files.filter((f) => !written.has(f));
  assert.deepEqual(missing, [], `这些文件没有写进《项目索引》：\n${missing.join('\n')}`);

  // 反过来：索引里像路径的内容都要存在（通配符和占位符除外）
  const pathLike = [...written].filter((t) => /^(api|lead-api|site|e2e|config|\.github|需求文档|技术方案|测试报告|部署方案|交付记录|assets)\//.test(t) || /^[^\s/]+\.(md|json)$/.test(t));
  const stale = pathLike.filter((t) => !/[*<]/.test(t) && !existsSync(join(ROOT, t)));
  assert.deepEqual(stale, [], `《项目索引》里写到的这些路径已经不存在：\n${stale.join('\n')}`);
});

test('项目索引：每个接口的每个动作都写了，没有写已经删除的动作', () => {
  const stub = {};
  const groups = [
    ['`/api/merchant/?a=`', createMerchantApi({ db: stub, keys: stub, ops: stub, send: () => {} }).actions],
    ['`/api/wallet/?a=`', createWalletApi({ db: stub, tron: stub, keys: stub, wallets: stub, requireAdmin: () => {}, verifyAdminCode: () => {}, send: () => {} }).actions],
    ['`/api/kyb/?g=admin&a=`', createAdminHandler({ repo: stub, blobs: stub, send: () => {}, redis: stub, keys: stub, config: stub }).actions],
    ['`/api/kyb/?g=onboarding&a=`', createOnboardingHandler({ repo: stub, blobs: stub, send: () => {}, config: stub }).actions],
    ['`/api/v1/`', createApiV1({ db: stub, keys: stub, ops: stub }).routes],
  ];
  for (const [title, actual] of groups) {
    assert.deepEqual([...new Set(firstCol(section(title)))].sort(), [...actual].sort(), `《项目索引》的 ${title} 和代码里的动作不一致`);
  }
});

test('项目索引：每张数据库表、pay_meta 的每个键都写了', () => {
  const tables = [...SCHEMA.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(firstCol(section('4.1')).sort(), [...tables].sort(), '《项目索引》§4.1 的表和建表脚本不一致');
  const src = walk('lead-api/src/pay').filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const keys = new Set([
    ...[...src.matchAll(/[gs]etMeta\(\w+, '(\w+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/pay_meta \(key, value\) values \('(\w+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/from pay_meta where key = '(\w+)'/g)].map((m) => m[1]),
  ]);
  const meta = new Set(ticks(section('4.1')));
  const missing = [...keys].filter((k) => !meta.has(k));
  assert.deepEqual(missing, [], `pay_meta 的这些键没有写进《项目索引》§4.1：${missing.join('、')}`);
});

test('项目索引：代码读取的每个环境变量都写了，写到的变量都还在用', () => {
  const code = [...walk('api'), ...walk('lead-api/src'), ...walk('lead-api/scripts'), ...walk('site/src'), 'site/astro.config.mjs', ...walk('e2e', ['e2e/tests']), ...walk('e2e/tests'), ...walk('.github/workflows')]
    .filter((f) => /\.(js|mjs|ts|astro|sh|yml|py)$/.test(f)).map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const used = new Set([
    ...[...code.matchAll(/\benv(?:\.|\[['"])([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\$\{\{\s*(?:vars|secrets)\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
  ]);
  const listed = new Set(firstCol(section('5. 环境变量')).filter((t) => /^[A-Z][A-Z0-9_]+$/.test(t)));
  const missing = [...used].filter((v) => !listed.has(v));
  assert.deepEqual(missing, [], `这些环境变量没有写进《项目索引》§5：${missing.join('、')}`);
  const unused = [...listed].filter((v) => !new RegExp(`\\b${v}\\b`).test(code));
  assert.deepEqual(unused, [], `《项目索引》§5 里的这些变量代码里已经不用了：${unused.join('、')}`);
});

test('项目索引：运营后台和商户后台的每个标签都写了；项目地图指向索引', () => {
  const admin = readFileSync(join(ROOT, 'site/src/pages/admin/index.astro'), 'utf8');
  const merchant = readFileSync(join(ROOT, 'site/src/pages/[...lang]/merchant.astro'), 'utf8');
  const tabs = [
    ...[...admin.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]),
    ...JSON.parse(merchant.match(/const tabs = (\[[^\]]+\])/)[1].replace(/'/g, '"')),
  ];
  const written = new Set(ticks(section('3. 页面索引')));
  const missing = tabs.filter((t) => !written.has(t));
  assert.deepEqual(missing, [], `这些后台标签没有写进《项目索引》§3：${missing.join('、')}`);
  assert.ok(MAP.includes('项目索引.md'), '《项目地图》要指向《项目索引》');
});
