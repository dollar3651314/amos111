import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

// TC-09 (AC3) 375 / 768 / 1280 三种宽度下没有横向滚动，元素没有溢出视口；同时保存截图供人工复核
const WIDTHS = [375, 768, 1280];
for (const w of WIDTHS) {
  for (const p of PAGES) {
    test(`TC-09 AC3 ${w}px ${p.path}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(p.path);
      const res = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const overflow: string[] = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          if (el.closest('.hp, .sr-only, [aria-hidden="true"] *, .skip-link')) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.right > vw + 1 || r.left < -1) overflow.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
        }
        return { scrollW: document.documentElement.scrollWidth, vw, overflow: overflow.slice(0, 5) };
      });
      expect(res.scrollW, '页面出现横向滚动').toBeLessThanOrEqual(res.vw);
      expect(res.overflow, '元素溢出视口').toEqual([]);
      await page.screenshot({ path: `.tmp/screens/${w}${p.path.replace(/\//g, '_')}.png`, fullPage: true });
    });
  }
}
