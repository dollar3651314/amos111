import { test, expect } from '@playwright/test';
import { readJsonl, DATA_MAIN, MAILS } from '../stack.mjs';
import { resolve } from 'node:path';

const LEADS = resolve(DATA_MAIN, 'leads.jsonl');
const leadCount = () => readJsonl(LEADS).filter((r) => r.type === 'lead').length;
const settle = () => new Promise((r) => setTimeout(r, 800));

// TC-12 (AC5) 前端：必填项为空时阻止提交，并在对应字段旁提示
for (const lang of ['en', 'zh'] as const) {
  test(`TC-12 AC5 ${lang} 必填项为空时阻止提交`, async ({ page }) => {
    const path = lang === 'en' ? '/contact/' : '/zh/contact/';
    let requests = 0;
    page.on('request', (r) => r.url().includes('/api/leads') && requests++);
    await page.goto(path);
    await page.click('[data-submit]');
    for (const f of ['name', 'company', 'email', 'country', 'industry', 'consent']) {
      await expect(page.locator(`[data-error-for="${f}"]`)).not.toBeEmpty();
      if (f !== 'consent') await expect(page.locator(`[name="${f}"]`)).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(page.locator('[data-form-alert]')).toBeVisible();
    expect(requests).toBe(0);
  });
}

// TC-13 (AC5) 前端：邮箱格式错误、电话格式错误
test('TC-13 AC5 邮箱和电话格式错误时提示', async ({ page }) => {
  await page.goto('/contact/');
  await page.fill('#f-email', 'not-an-email');
  await page.fill('#f-phone', 'call me maybe');
  await page.click('[data-submit]');
  await expect(page.locator('[data-error-for="email"]')).toContainText('valid email');
  await expect(page.locator('[data-error-for="phone"]')).toContainText('digits');
});

async function fillValid(page, lang: 'en' | 'zh', company: string) {
  await page.fill('#f-name', lang === 'en' ? 'Jane Doe' : '张三');
  await page.fill('#f-company', company);
  await page.fill('#f-email', 'jane@acme-export.com');
  await page.fill('#f-country', 'Vietnam');
  await page.selectOption('#f-industry', 'manufacturing');
  await page.selectOption('#f-volume', '250k-1m');
  await page.fill('#f-phone', '+84 (0) 912-345-678');
  await page.fill('#f-message', 'We export furniture.\nInterested in USDT.');
  await page.check('#f-consent');
}

// TC-14 (AC6) 合法提交：页面显示成功；本地备份新增 1 条记录；SMTP 收到 1 封包含全部字段的邮件
for (const lang of ['en', 'zh'] as const) {
  test(`TC-14 AC6 ${lang} 合法提交全链路`, async ({ page }) => {
    const company = `Acme ${lang.toUpperCase()} ${Date.now()}`;
    const before = leadCount();
    await page.goto(lang === 'en' ? '/contact/' : '/zh/contact/');
    await fillValid(page, lang, company);
    await page.click('[data-submit]');
    await expect(page.locator('[data-lead-success]')).toBeVisible();
    await expect(page.locator('[data-lead-form]')).toBeHidden();
    await settle();

    expect(leadCount()).toBe(before + 1);
    const recs = readJsonl(LEADS);
    const lead = recs.filter((r) => r.type === 'lead').pop();
    expect(lead.data).toMatchObject({ company, country: 'Vietnam', industry: 'manufacturing', volume: '250k-1m', lang, consent: true });
    expect(lead.ip).toBe('127.0.0.1'); // Nginx 通过 X-Real-IP 传递了客户端 IP
    expect(recs.find((r) => r.type === 'mail' && r.id === lead.id)?.ok).toBe(true);

    const mail = readJsonl(MAILS).find((m) => m.raw.includes(company));
    expect(mail, '模拟 SMTP 服务器没有收到邮件').toBeTruthy();
    expect(mail.to).toEqual(['sales@quickcomepay.test']);
    for (const s of ['Name:', 'Company:', 'Email: jane@acme-export.com', 'Country/Region: Vietnam', 'Industry: manufacturing',
      'Monthly volume: 250k-1m', 'Phone/WhatsApp: +84 (0) 912-345-678', 'We export furniture.', `Site language: ${lang}`]) {
      expect(mail.raw).toContain(s);
    }
    expect(mail.raw).toMatch(/Reply-To: jane@acme-export\.com/i);
  });
}

// TC-15 (AC5/F3) 服务端返回错误时，前端的展示和重试
test('TC-15 F3 服务端返回 429 / 500 / 网络失败时显示明确提示，并可重试', async ({ page }) => {
  await page.goto('/contact/');
  await fillValid(page, 'en', 'Retry Co');
  for (const [status, text] of [[429, 'Too many requests'], [500, 'Something went wrong']] as const) {
    await page.route('**/api/leads', (r) => r.fulfill({ status, body: '{}' }));
    await page.click('[data-submit]');
    await expect(page.locator('[data-form-alert]')).toContainText(text);
    await expect(page.locator('[data-submit]')).toBeEnabled();
    await page.unroute('**/api/leads');
  }
  await page.route('**/api/leads', (r) => r.abort());
  await page.click('[data-submit]');
  await expect(page.locator('[data-form-alert]')).toContainText('could not send');
  await page.unroute('**/api/leads');
});

// TC-16 (AC5) 服务端字段错误能显示到对应字段旁（模拟前端校验被绕过的情况）
test('TC-16 AC5 服务端字段错误映射到字段提示', async ({ page }) => {
  await page.goto('/contact/');
  await fillValid(page, 'en', 'Server Err Co');
  await page.route('**/api/leads', (r) =>
    r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'validation', fields: { email: 'format' } }) }));
  await page.click('[data-submit]');
  await expect(page.locator('[data-error-for="email"]')).toContainText('valid email');
  await expect(page.locator('#f-email')).toHaveAttribute('aria-invalid', 'true');
});
