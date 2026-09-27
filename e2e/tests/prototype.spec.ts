import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_PROTO } from '../stack.mjs';
import { PAGES } from './pages';

const PROTO = 'http://127.0.0.1:8090';

// TC-22 (AC13) 原型模式（Vercel 预览环境）：每页都有原型标识和 noindex；正式构建里没有
for (const p of PAGES) {
  test(`TC-22 AC13 ${p.path} 原型构建带标识，正式构建不带`, async ({ page }) => {
    await page.goto(PROTO + p.path);
    await expect(page.locator('[data-prototype-banner]')).toBeVisible();
    await expect(page.locator('[data-prototype-banner]')).toContainText('PROTOTYPE');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await page.goto(p.path); // 正式构建（8080）
    await expect(page.locator('[data-prototype-banner]')).toHaveCount(0);
  });
}

// TC-23 (AC13) 原型模式下表单为模拟提交：显示成功，但不调用任何接口，也不写入存储
for (const lang of ['en', 'zh'] as const) {
  test(`TC-23 AC13 ${lang} 原型表单模拟提交，不发送任何数据`, async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (r) => r.url().includes('/api/') && apiCalls.push(r.url()));
    await page.goto(PROTO + (lang === 'en' ? '/contact/' : '/zh/contact/'));
    await page.click('[data-submit]');
    await expect(page.locator('[data-error-for="name"]')).not.toBeEmpty(); // 前端校验在原型中照常工作
    await page.fill('#f-name', 'Proto'); await page.fill('#f-company', 'Proto Co'); await page.fill('#f-email', 'p@proto.com');
    await page.fill('#f-country', 'Vietnam'); await page.selectOption('#f-industry', 'export'); await page.check('#f-consent');
    await page.click('[data-submit]');
    await expect(page.locator('[data-lead-success]')).toBeVisible();
    expect(apiCalls).toEqual([]);
    expect(existsSync(resolve(DATA_PROTO, 'leads.jsonl'))).toBe(false);
  });
}
