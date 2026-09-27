import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

// TC-10 (AC8) 全站文字里不出现法币费率、法币到账时间的具体数字
// 检查规则：百分比；"N 天 / N 个工作日 / N days / N business days / N hours"这类时效数字；
//           带数字的法币金额或费用（$、USD、美元、fee、手续费）。
// 例外：联系表单"月均收款规模"下拉框里的金额区间，属于客户自填的规模档位，
//       不是费率或时效，所以扫描前排除（已在测试报告中说明，由 PM 确认口径）。
//       "24/7, 365 days a year" 描述的是服务可用时间，不是到账时效，同样排除（第 1 轮误报，见测试报告）。
const PATTERNS: [string, RegExp][] = [
  ['百分比', /\d+(?:\.\d+)?\s*%/],
  ['英文时效数字', /\b\d+\s*(?:-|–|to)?\s*\d*\s*(?:business\s+|working\s+)?(?:days?|hours?|hrs?)\b/i],
  ['中文时效数字', /\d+\s*(?:-|–|至|到)?\s*\d*\s*(?:个)?(?:工作日|天|小时内|小时到账)/],
  ['英文法币金额', /(?:\$|USD|EUR|HKD|SGD)\s?\d/i],
  ['中文法币金额', /\d+(?:\.\d+)?\s*(?:万)?\s*(?:美元|元|港币|欧元)/],
  ['费用数字', /(?:fee|fees|charge|手续费|费率)[^.。]{0,20}\d/i],
];

for (const p of PAGES) {
  test(`TC-10 AC8 ${p.path} 无法币数字承诺`, async ({ page }) => {
    await page.goto(p.path);
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('#f-volume, script, style').forEach((e) => e.remove());
      return clone.innerText.replace(/24\/7, 365 days a year/g, '');
    });
    const hits = PATTERNS.flatMap(([name, re]) => {
      const m = text.match(new RegExp(re.source, re.flags + 'g'));
      return m ? [`${name}: ${m.join(' | ')}`] : [];
    });
    expect(hits, hits.join('\n')).toEqual([]);
  });
}

// TC-11 (AC8) 涉及法币的位置都写"与销售协商 / Contact sales"
test('TC-11 AC8 首页对比表的法币行与工作原理页的法币区块都引导联系销售', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('table tr', { hasText: 'Fiat payout' })).toContainText('Contact sales');
  await page.goto('/zh/');
  await expect(page.locator('table tr', { hasText: '法币出金' })).toContainText('与销售协商');
  await page.goto('/how-it-works/');
  await expect(page.locator('[data-fiat-section]')).toContainText('Contact sales');
  await page.goto('/zh/how-it-works/');
  await expect(page.locator('[data-fiat-section]')).toContainText('联系销售');
});
