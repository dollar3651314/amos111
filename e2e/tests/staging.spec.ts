import { test, expect } from '@playwright/test';
import { readJsonl, decodeQP, MAILS } from '../stack.mjs';

// v5（agents v0.6 C34）：测试环境 = Vercel 预览 + APP_ENV=staging。真实接口，蓝色"测试环境"标识，noindex，邮件标题带"[测试环境]"
const STG = 'http://127.0.0.1:8092';

// 解码邮件头里的 Subject（RFC 2047：=?UTF-8?Q?...?= 和 =?UTF-8?B?...?=，可能折成多行）
function subjectOf(raw: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = head.split(/\r?\n/).find((l) => /^subject:/i.test(l))!.replace(/^subject:\s*/i, '');
  return line.replace(/\?=\s+=\?/g, '?==?').replace(/=\?utf-8\?([qb])\?(.*?)\?=/gi, (_, enc, t) => enc.toLowerCase() === 'b'
    ? Buffer.from(t, 'base64').toString('utf8')
    : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
}

for (const path of ['/', '/zh/contact/', '/onboarding/?t=x', '/admin/']) {
  test(`TC-S01 ${path} 显示测试环境标识，没有原型标识，而且 noindex`, async ({ page }) => {
    await page.goto(STG + path);
    await expect(page.locator('[data-staging-banner]')).toBeVisible();
    await expect(page.locator('[data-staging-banner]')).toContainText('STAGING');
    await expect(page.locator('[data-prototype-banner]')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
}

test('TC-S02 测试环境使用真实接口：开户页不是原型模式（无效链接显示"链接无效"）', async ({ page }) => {
  await page.goto(STG + '/onboarding/?t=not-a-real-token');
  await expect(page.locator('[data-ob-invalid]')).toBeVisible();
  expect(JSON.parse((await page.locator('#ob-root').getAttribute('data-config'))!).prototype).toBe(false);
});

test('TC-S03 测试环境提交官网表单：真实提交，通知邮件标题带"[测试环境]"', async ({ page }) => {
  await page.goto(STG + '/contact/');
  await page.fill('#f-name', 'Stg'); await page.fill('#f-company', 'Staging Probe Co'); await page.fill('#f-email', 'stg@probe.example');
  await page.fill('#f-country', 'Vietnam'); await page.selectOption('#f-industry', 'export'); await page.check('#f-consent');
  await page.click('[data-submit]');
  await expect(page.locator('[data-lead-success]')).toBeVisible();
  await expect.poll(() => { const m = readJsonl(MAILS).find((x: any) => decodeQP(x.raw).includes('Staging Probe Co')); return m ? subjectOf(m.raw) : ''; }).toBe('[测试环境] [Quick Come] New demo request: Staging Probe Co');
});

test('TC-S04 正式构建没有测试环境标识', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-staging-banner]')).toHaveCount(0);
});
