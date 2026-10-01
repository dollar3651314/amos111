import { test, expect } from '@playwright/test';
import { PAGES } from './pages';

// TC-01 (AC1) 16 个页面全部返回 200
for (const p of PAGES) {
  test(`TC-01 AC1 ${p.path} 可访问`, async ({ request }) => {
    const r = await request.get(p.path);
    expect(r.status()).toBe(200);
  });
}

// TC-02 (AC1) 站内链接没有死链：爬取每个页面上的所有站内链接和资源
test('TC-02 AC1 全站站内链接和资源无 404', async ({ page, request }) => {
  const seen = new Set<string>();
  for (const p of PAGES) {
    await page.goto(p.path);
    const urls = await page.$$eval('a[href], link[href], script[src], img[src]', (els) =>
      els.map((e) => (e as HTMLAnchorElement).href || (e as HTMLScriptElement).src),
    );
    for (const u of urls) {
      const url = new URL(u);
      if (url.origin !== 'http://127.0.0.1:8080' && !url.href.startsWith('https://quickcomepay.com')) continue;
      seen.add(url.pathname);
    }
  }
  const broken: string[] = [];
  for (const path of seen) {
    const r = await request.get(path);
    if (r.status() !== 200) broken.push(`${path} → ${r.status()}`);
  }
  expect(broken, `死链：${broken.join(', ')}`).toEqual([]);
  expect(seen.size).toBeGreaterThan(20);
});

// TC-03 (AC2) 语言切换跳到另一种语言的对应页面
for (const p of PAGES) {
  test(`TC-03 AC2 ${p.path} 语言切换 → ${p.other}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(p.path);
    await page.click('[data-lang-switch]');
    await expect(page).toHaveURL(p.other);
    await expect(page.locator('html')).toHaveAttribute('lang', p.lang === 'en' ? 'zh-Hans' : 'en');
  });
}

// TC-04 (AC4) 每个页面都能直接点到"预约演示"：桌面端在导航栏，手机端在菜单里
for (const p of PAGES) {
  test(`TC-04 AC4 ${p.path} 预约演示入口`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(p.path);
    const cta = page.locator('header [data-cta]');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', p.lang === 'en' ? '/contact/' : '/zh/contact/');

    await page.setViewportSize({ width: 375, height: 812 });
    await page.click('[data-menu-toggle]');
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(p.lang === 'en' ? '/contact/' : '/zh/contact/');
  });
}

// TC-05 (AC9) 每个页面的页脚都有风险提示、隐私政策、服务条款、不面向中国大陆的声明
for (const p of PAGES) {
  test(`TC-05 AC9 ${p.path} 页脚合规要素`, async ({ page }) => {
    await page.goto(p.path);
    const f = page.locator('footer');
    await expect(f.locator('[data-risk-notice]')).toBeVisible();
    await expect(f.locator('[data-risk-notice]')).toContainText(p.lang === 'en' ? 'irreversible' : '不可撤销');
    await expect(f.locator('[data-footer-privacy]')).toHaveAttribute('href', p.lang === 'en' ? '/privacy/' : '/zh/privacy/');
    await expect(f.locator('[data-footer-terms]')).toHaveAttribute('href', p.lang === 'en' ? '/terms/' : '/zh/terms/');
    await expect(f.locator('[data-not-mainland]')).toContainText(p.lang === 'en' ? 'Mainland China' : '中国大陆');
  });
}

// TC-06 (AC11) 标题和描述各不相同；hreflang、canonical 正确
test('TC-06 AC11 每页有独立的标题和描述，以及正确的语言互指标注', async ({ page }) => {
  const titles = new Set<string>();
  const descs = new Set<string>();
  for (const p of PAGES) {
    await page.goto(p.path);
    const title = await page.title();
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(title.length, `${p.path} 标题`).toBeGreaterThan(5);
    // 中文信息密度更高，长度阈值按语言区分
    expect(desc?.length ?? 0, `${p.path} 描述`).toBeGreaterThan(p.lang === 'en' ? 50 : 20);
    titles.add(title);
    descs.add(desc!);
    const en = p.lang === 'en' ? p.path : p.other;
    const zh = p.lang === 'zh' ? p.path : p.other;
    await expect(page.locator('link[hreflang="en"]')).toHaveAttribute('href', `https://quickcomepay.com${en}`);
    await expect(page.locator('link[hreflang="zh-Hans"]')).toHaveAttribute('href', `https://quickcomepay.com${zh}`);
    await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute('href', `https://quickcomepay.com${en}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://quickcomepay.com${p.path}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /og-image\.png$/);
  }
  expect(titles.size).toBe(PAGES.length);
  expect(descs.size).toBe(PAGES.length);
});

// TC-07 (AC11) sitemap 和 robots
test('TC-07 AC11 sitemap.xml 包含全部 16 个页面，robots.txt 引用 sitemap', async ({ request }) => {
  const sm = await request.get('/sitemap.xml');
  expect(sm.status()).toBe(200);
  const xml = await sm.text();
  for (const p of PAGES) expect(xml).toContain(`<loc>https://quickcomepay.com${p.path}</loc>`);
  expect((xml.match(/<url>/g) || []).length).toBe(PAGES.length);
  const rb = await request.get('/robots.txt');
  expect(rb.status()).toBe(200);
  expect(await rb.text()).toContain('Sitemap: https://quickcomepay.com/sitemap.xml');
});

// TC-08 补充：404 页面、安全响应头、页面无控制台报错（包括 CSP 拦截）
test('TC-08 补充 不存在的页面返回 404 页面', async ({ request }) => {
  const r = await request.get('/no-such-page/');
  expect(r.status()).toBe(404);
  expect(await r.text()).toContain('Page not found');
});

test('TC-08 补充 安全响应头齐全（按 vercel.json；v2.2 起严格 CSP 和 HSTS 对所有地址生效）', async ({ request }) => {
  for (const path of ['/', '/zh/contact/', '/favicon.svg']) {
    const h = (await request.get(path)).headers();
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBeTruthy();
    expect(h['content-security-policy'], path).toContain("script-src 'self'");
    expect(h['strict-transport-security'], path).toContain('max-age=31536000');
  }
});

// TC-08b 补充：生产环境启用了严格 CSP（禁止内联脚本和内联样式），构建产物必须与之兼容
test('TC-08b 补充 构建产物中没有内联脚本、内联样式和 style 属性（与严格 CSP 兼容）', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dist = join(process.cwd(), '..', 'site', 'dist');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : [];
  });
  const bad: string[] = [];
  for (const f of walk(dist)) {
    const html = readFileSync(f, 'utf8');
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) bad.push(`${f}: 内联 <script>`);
    if (/<style[\s>]/i.test(html)) bad.push(`${f}: 内联 <style>`);
    if (/\sstyle="/i.test(html)) bad.push(`${f}: style 属性`);
  }
  expect(bad).toEqual([]);
});

for (const p of PAGES) {
  test(`TC-08 补充 ${p.path} 无控制台报错`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(p.path, { waitUntil: 'networkidle' });
    expect(errors).toEqual([]);
  });
}

// ---------- v7.1：商户登录和管理平台入口 ----------
// TC-V71-1 (AC-7.1-1～3) 每个页面：页头和页脚"公司"一栏有商户登录（跟随当前语言），页脚最底部有不显眼的管理平台入口
for (const p of PAGES) {
  test(`TC-V71-1 AC-7.1-1～3 ${p.path} 商户登录和管理平台入口`, async ({ page }) => {
    const merchant = p.lang === 'en' ? '/merchant/' : '/zh/merchant/';
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(p.path);
    const login = page.locator('header [data-merchant-login]');
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute('href', merchant);
    await expect(login).toHaveText(p.lang === 'en' ? 'Merchant login' : '商户登录');
    await expect(page.locator('footer [data-footer-merchant]')).toHaveAttribute('href', merchant);
    const admin = page.locator('footer [data-admin-login]');
    await expect(admin).toHaveAttribute('href', '/admin/');
    await expect(admin).toHaveAttribute('rel', 'nofollow');
    await expect(admin).toHaveText(p.lang === 'en' ? 'Admin' : '管理平台');
    // 不显眼：字号比版权小
    const [adminSize, copySize] = await Promise.all([admin, page.locator('footer .copy')].map((l) => l.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))));
    expect(adminSize).toBeLessThan(copySize);
    // 手机：菜单里有商户登录
    await page.setViewportSize({ width: 375, height: 812 });
    await page.click('[data-menu-toggle]');
    await expect(login).toBeVisible();
  });
}

// TC-V71-2 (AC-7.1-1) 点击进入对应语言的商户后台登录页；管理平台进入后台
test('TC-V71-2 AC-7.1-1 AC-7.1-3 点击商户登录、管理平台进入对应页面', async ({ page }) => {
  for (const [path, merchant] of [['/', '/merchant/'], ['/zh/', '/zh/merchant/']]) {
    await page.goto(path);
    await page.click('header [data-merchant-login]');
    await expect(page).toHaveURL(merchant);
    await expect(page.locator('[data-view="login"]')).toHaveCount(1); // 商户后台页面（8080 实例没有收付款接口，这里只确认到了这个页面）
  }
  await page.goto('/zh/');
  await page.click('footer [data-admin-login]');
  await expect(page).toHaveURL('/admin/');
});

// TC-V71-3 (AC-7.1-4) 几种宽度下页头的文字都不折行（加了商户登录后，英文导航在 961～1100 曾经折成两行）
for (const w of [375, 768, 1000, 1024, 1101, 1280]) {
  for (const path of ['/', '/zh/']) {
    test(`TC-V71-3 AC-7.1-4 ${w}px ${path} 页头不折行、无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto(path);
      const r = await page.evaluate(() => ({
        over: document.documentElement.scrollWidth - window.innerWidth,
        // 可见的导航文字链接和 Logo 都只有一行
        wrapped: [...document.querySelectorAll<HTMLElement>('header .brand, header .nav a:not(.btn)')].filter((a) => a.offsetParent && a.getClientRects().length > 1).map((a) => a.textContent?.trim()),
        brandH: document.querySelector('header .brand')!.getBoundingClientRect().height,
      }));
      expect(r.over).toBeLessThanOrEqual(0);
      expect(r.wrapped).toEqual([]);
      expect(r.brandH).toBeLessThan(48);
    });
  }
}

// TC-V71-4 (AC-7.1-5) 站点地图不包含商户后台和管理平台
test('TC-V71-4 AC-7.1-5 sitemap 不包含 /merchant/、/admin/', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  expect(xml).not.toContain('/merchant/');
  expect(xml).not.toContain('/admin/');
});
