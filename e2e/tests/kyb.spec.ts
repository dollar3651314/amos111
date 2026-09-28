import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, DATA_MAIN, KYB_ENV } from '../stack.mjs';
// @ts-ignore 与后端同一份 TOTP 实现（已用 RFC 6238 测试向量验证）
import { totpCode } from '../../lead-api/src/kyb/totp.js';

// v3 开户（KYB）端到端：初始化后台 → 登录 → 从官网线索发送链接 → 客户填写 7 步并上传、签名、提交
// → 后台要求补件 → 客户只改被开放的部分再提交 → 通过 → 删除。串行执行，共享同一个后台账号。
const PW = 'e2e-admin-password-1';
const COMPANY = 'Mekong Export Co';
const CLIENT = 'kyb-client@mekong.example';
const PDF = { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e test file\n') };
const PNG = { name: 'id.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]) };
let totpSecret = '';
let ref = '';
let adminCtx: BrowserContext;
let admin: Page;

const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
const linkIn = (mail: string) => mail.match(/https?:\/\/[^\s]+\/onboarding\/\?t=[A-Za-z0-9_-]+/)![0];
const cspErrors = (page: Page) => { const errs: string[] = []; page.on('console', (m) => /Content Security Policy/i.test(m.text()) && errs.push(m.text())); return errs; };

const browserGet = (page: Page, url: string) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'same-origin' });
  return { status: r.status, disposition: r.headers.get('content-disposition') || '', text: await r.text() };
}, url);

// 用鼠标在签名框里画一笔；先等页面滚动停下，避免坐标偏移
async function sign(page: Page) {
  const cv = page.locator('[data-signature]');
  await cv.scrollIntoViewIfNeeded();
  let box = (await cv.boundingBox())!;
  await expect.poll(async () => { const b = (await cv.boundingBox())!; const same = b.y === box.y; box = b; return same; }).toBe(true);
  await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 18, box.y + box.height / 2 + (i % 2 ? -18 : 18));
  await page.mouse.up();
}

async function login(page: Page) {
  await page.goto('/admin/');
  await expect(page.locator('[data-view="login"]')).toBeVisible();
  await page.fill('#a-pw', PW);
  await page.fill('#a-otp', totpCode(totpSecret, Date.now()));
  await page.click('[data-login] button[type="submit"]');
  await expect(page.locator('[data-view="app"]')).toBeVisible();
}
async function confirmDialog(page: Page) {
  await page.click('[data-dialog-ok]');
  await expect(page.locator('[data-dialog]')).not.toBeVisible();
}
async function fillText(page: Page, values: Record<string, string>) {
  for (const [name, v] of Object.entries(values)) await page.fill(`[name="${name}"]`, v);
}
async function next(page: Page, step: number) {
  await page.click('[data-next]');
  await expect(page.locator(`[data-step="${step}"]`)).toBeVisible();
}

test.describe.serial('TC-K v3 在线开户', () => {
  test.beforeAll(async ({ browser }) => {
    adminCtx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    admin = await adminCtx.newPage();
  });
  test.afterAll(async () => { await adminCtx.close(); });

  test('TC-K01 AC-K8 后台首次初始化：口令 + 密码 + 绑定验证器', async () => {
    const errs = cspErrors(admin);
    await admin.goto('/admin/');
    await expect(admin.locator('[data-view="setup"]')).toBeVisible();
    await admin.fill('#s-token', 'wrong-token');
    await admin.fill('#s-pw', PW); await admin.fill('#s-pw2', PW);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup-err]')).toBeVisible();
    await admin.fill('#s-token', KYB_ENV.ADMIN_SETUP_TOKEN);
    await admin.click('[data-setup] button[type="submit"]');
    await expect(admin.locator('[data-setup2]')).toBeVisible();
    await expect(admin.locator('[data-qr]')).toHaveAttribute('src', /^data:image\/png;base64,/);
    totpSecret = (await admin.locator('[data-secret]').textContent())!.replace(/\s/g, '');
    expect(totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    await admin.fill('#s-otp', '000000');
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-setup2-err]')).toBeVisible();
    await admin.fill('#s-otp', totpCode(totpSecret, Date.now()));
    await admin.click('[data-setup2] button[type="submit"]');
    await expect(admin.locator('[data-view="login"]')).toBeVisible();
    // 已初始化后，不能再次初始化
    const again = await admin.request.post('/api/admin/setup-begin/', { data: { setupToken: KYB_ENV.ADMIN_SETUP_TOKEN, password: PW } });
    expect(again.status()).toBe(409);
    expect(errs).toEqual([]);
  });

  test('TC-K02 AC-K8 登录：密码或动态码错误被拒绝；正确后进入后台；会话 Cookie 为 HttpOnly', async () => {
    await admin.goto('/admin/');
    await admin.fill('#a-pw', PW); await admin.fill('#a-otp', '123456');
    await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-login-err]')).toBeVisible();
    await login(admin);
    const c = (await adminCtx.cookies()).find((x) => x.name === 'qc_admin')!;
    expect(c.httpOnly).toBe(true); expect(c.sameSite).toBe('Strict');
  });

  test('TC-K03 AC-K1 从官网线索一键发送开户链接，客户收到 30 天有效的专属链接', async ({ page }) => {
    await page.goto('/zh/contact/');
    await page.fill('#f-name', 'Lan Nguyen'); await page.fill('#f-company', COMPANY); await page.fill('#f-email', CLIENT);
    await page.fill('#f-country', 'Vietnam'); await page.selectOption('#f-industry', 'export'); await page.check('#f-consent');
    await page.click('[data-submit]');
    await expect(page.locator('[data-lead-success]')).toBeVisible();

    await admin.click('[data-tab="leads"]');
    const row = admin.locator('[data-leads-body] tr', { hasText: COMPANY });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '发送开户链接' }).click();
    await expect(admin.locator('#i-co')).toHaveValue(COMPANY);
    await expect(admin.locator('#i-em')).toHaveValue(CLIENT);
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已创建 QC-');
    await expect(row.getByRole('button', { name: '已发送' })).toBeDisabled();
    ref = (await admin.locator('[data-toast]').textContent())!.match(/QC-\d{4}-\d{4}/)![0];

    const mail = mailsTo(CLIENT).at(-1)!;
    expect(mail).toContain('Quick Come');
    expect(mail).toContain(ref);
    expect(mail).not.toMatch(/paypaz/i);
    const link = linkIn(mail);
    expect(new URL(link).searchParams.get('t')!.length).toBeGreaterThanOrEqual(43);
  });

  test('TC-K04 AC-K3 AC-K4 AC-K5 AC-K6 客户填写 7 步（中途离开可继续）、上传文件、签名提交', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    const errs = cspErrors(page);
    const link = linkIn(mailsTo(CLIENT).at(-1)!);
    await page.goto(link);
    await expect(page.locator('#ob-form')).toBeVisible();
    await expect(page.locator('[data-meta="company"]')).toHaveText(COMPANY);
    await expect(page.locator('[data-meta="ref"]')).toHaveText(ref);

    // ① 必填项为空时不能进入下一步
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.legalName"]')).not.toBeEmpty();
    await fillText(page, {
      'entity.legalName': 'Mekong Export Company Limited', 'entity.legalForm': 'Limited liability company', 'entity.regNumber': '0312345678',
      'entity.incDate': '2019-03-12', 'entity.incPlace': 'Ho Chi Minh City, Vietnam', 'entity.regAddress': '12 Nguyen Hue, District 1', 'entity.physAddress': '12 Nguyen Hue, District 1',
    });
    await page.check('[name="entity.nature"][value="export"]');
    await page.check('[name="entity.purpose"][value="deposits"]');
    await page.check('[name="entity.volume"][value="50k-100k"]');
    await page.check('[name="entity.markets"][value="apac"]');
    await next(page, 1);

    // 离开后用同一链接回来，已填内容还在（AC-K3）
    await page.goto(link);
    await expect(page.locator('[name="entity.legalName"]')).toHaveValue('Mekong Export Company Limited');
    await page.click('[data-goto="1"]');
    await expect(page.locator('[data-step="1"]')).toBeVisible();

    await fillText(page, { 'contact.website': 'mekong.example', 'contact.email': 'info@mekong.example', 'contact.phone': '+84 28 1234 5678' });
    await next(page, 2);
    await fillText(page, { 'rep.name': 'Lan Nguyen', 'rep.email': CLIENT, 'rep.phone': '+84 90 123 4567' });
    await next(page, 3);

    // ④ 人员：至少一名董事和一名最终受益人
    const p = page.locator('[data-person]').first();
    await p.locator('[name$=".roles"][value="director"]').check();
    await p.locator('[name$=".roles"][value="ubo"]').check();
    for (const [k, v] of Object.entries({ fullName: 'Nguyen Thi Lan', dob: '1985-06-01', nationality: 'Vietnam', residence: 'Vietnam', address: '5 Le Loi, District 1', passportNo: 'C9876543', passportCountry: 'Vietnam', passportExpiry: '2032-01-31', email: CLIENT, phone: '+84 90 123 4567' }))
      await p.locator(`[name$=".${k}"]`).fill(v);
    await p.locator('[name$=".pep"][value="yes"]').check();
    await expect(p.locator('[data-pep-details]')).toBeVisible(); // 选"是"时要求说明
    await p.locator('[name$=".pep"][value="no"]').check();
    await next(page, 4);

    // ⑤ 文件：缺必填文件时不能继续；类型不对被拒绝
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="docs"]')).not.toBeEmpty();
    await page.setInputFiles('[data-upload="d1"]', { name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('<b>x</b>') });
    await expect(page.locator('[data-files="d1"]')).not.toContainText('bad.html');
    for (const d of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
      await page.setInputFiles(`[data-upload="${d}"]`, { ...PDF, name: `${d}.pdf` });
      await expect(page.locator(`[data-files="${d}"]`)).toContainText(`${d}.pdf`);
    }
    for (const u of await page.locator('#person-docs input[type="file"]').all()) await u.setInputFiles(PNG);
    await expect(page.locator('#person-docs')).toContainText('id.png');
    await next(page, 5);

    // ⑥ 钱包授权声明（附录 B）
    await fillText(page, { 'wallet.clientName': 'Mekong Export Company Limited', 'wallet.idTypeNo': 'Business reg. 0312345678', 'wallet.email': 'info@mekong.example', 'wallet.address': 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' });
    await page.check('[name="wallet.network"][value="tron"]');
    await page.check('[name="wallet.use"][value="both"]');
    await page.check('[name="wallet.ownershipOk"]'); await page.check('[name="wallet.riskOk"]');
    await page.check('[name="wallet.proofType"][value="provider"]');
    await page.setInputFiles('[data-upload="walletProof"]', { ...PDF, name: 'wallet-proof.pdf' });
    await expect(page.locator('[data-files="walletProof"]')).toContainText('wallet-proof.pdf');
    await next(page, 6);

    // ⑦ 声明与签名：没签名不能提交（AC-K6）
    await fillText(page, { 'decl.repName': 'Nguyen Thi Lan', 'decl.position': 'Director' });
    await page.check('[name="decl.confirm"]');
    await page.click('[data-submit]');
    await expect(page.locator('[data-err-for="signature"]')).not.toBeEmpty();
    await sign(page);
    await page.click('[data-submit]');
    await expect(page.locator('[data-ob-done]')).toBeVisible();

    // 提交后同一链接只能看到"已提交"（AC-K7）
    await page.goto(link);
    await expect(page.locator('[data-ob-done]')).toBeVisible();
    await expect(page.locator('#ob-form')).toBeHidden();
    expect(errs).toEqual([]);
    await ctx.close();

    // Amos 收到通知，但通知里没有敏感信息
    const note = mailsTo('sales@quickcomepay.test').filter((m) => m.includes(ref)).at(-1)!;
    expect(note).toBeTruthy();
    for (const s of ['C9876543', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE']) expect(note).not.toContain(s);
  });

  test('TC-K05 AC-K10 存储中只有密文：护照号、地址、邮箱、钱包地址都不以明文出现', async () => {
    const raw = readFileSync(resolve(DATA_MAIN, 'kyb-redis.json'), 'utf8');
    expect(raw).toContain(ref);
    for (const s of ['C9876543', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', 'Mekong Export Company Limited', 'Nguyen Thi Lan']) expect(raw).not.toContain(s);
  });

  test('TC-K06 AC-K9 后台查看完整资料、下载文件、查看签名', async () => {
    await admin.click('[data-tab="apps"]');
    const row = admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`);
    await expect(row).toContainText('已提交');
    await row.click();
    await expect(admin.locator('[data-detail-sections]')).toContainText('Mekong Export Company Limited');
    await expect(admin.locator('[data-detail-sections]')).toContainText('C9876543');
    await expect(admin.locator('[data-side]')).toContainText(CLIENT);
    const sig = admin.getByRole('img', { name: '客户手写签名' });
    await expect(sig).toBeVisible();
    await expect.poll(() => sig.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // 签名图片在 CSP 下能正常加载
    const href = await admin.locator('.file-link a').first().getAttribute('href');
    // 在浏览器里下载（与 Amos 点击链接相同，带 HttpOnly 会话 Cookie）
    const res = await browserGet(admin, href!);
    expect(res.status).toBe(200);
    expect(res.disposition).toMatch(/^attachment/);
    expect(res.text).toContain('%PDF-1.4');
    // 未登录不能下载、不能看列表
    const anon = await admin.context().browser()!.newContext({ baseURL: 'http://127.0.0.1:8080' });
    expect((await anon.request.get(href!)).status()).toBe(401);
    expect((await anon.request.get('/api/admin/apps/')).status()).toBe(401);
    await anon.close();
  });

  test('TC-K07 AC-K11 要求补件：只开放勾选的部分，客户修改后再次签名提交', async ({ browser }) => {
    const oldLink = linkIn(mailsTo(CLIENT).at(-1)!);
    await admin.getByRole('button', { name: '要求补件' }).click();
    await admin.locator('[data-dialog] input[value="docs"]').check();
    await admin.fill('#ni-msg', '营业执照副本请上传彩色扫描件');
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已发送补件通知');
    await expect(admin.locator('[data-detail-sections]')).toContainText('已要求补件');

    const mail = mailsTo(CLIENT).at(-1)!;
    expect(mail).toContain('营业执照副本请上传彩色扫描件');
    const link = linkIn(mail);
    expect(link).not.toBe(oldLink);

    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    await page.goto(oldLink);
    await expect(page.locator('[data-ob-invalid]')).toBeVisible(); // 旧链接失效
    await page.goto(link);
    await expect(page.locator('#ob-form')).toBeVisible();
    await expect(page.locator('[name="entity.legalName"]')).toBeDisabled(); // 未开放的部分只读
    await page.click('[data-goto="4"]');
    await expect(page.locator('[data-upload="d1"]')).toBeEnabled();
    await page.setInputFiles('[data-upload="d1"]', { ...PDF, name: 'd1-colour.pdf' });
    await expect(page.locator('[data-files="d1"]')).toContainText('d1-colour.pdf');
    await page.click('[data-goto="6"]');
    await sign(page);
    await page.click('[data-submit]');
    await expect(page.locator('[data-ob-done]')).toBeVisible();
    await ctx.close();
  });

  test('TC-K08 AC-K9 通过申请；保留期显示为"业务关系存续期间"；操作记录完整', async () => {
    await admin.click('[data-back-list]');
    const row = admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`);
    await expect(row).toContainText('已提交');
    await row.click();
    await expect(admin.locator('[data-detail-sections]')).toContainText('d1-colour.pdf');
    await admin.getByRole('button', { name: '通过' }).click();
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已通过');
    await expect(admin.locator('[data-side]')).toContainText('业务关系存续期间');
    await expect(admin.locator('.timeline-mini')).toContainText('补件');
    await admin.fill('#rv-notes', 'e2e 内部备注');
    await admin.locator('#rv-notes').blur();
    await expect(admin.locator('[data-toast]')).toContainText('备注已保存');
  });

  test('TC-K09 AC-K12 删除申请需要输入编号；删除后申请和文件都无法访问', async () => {
    const href = await admin.locator('.file-link a').first().getAttribute('href');
    await admin.getByRole('button', { name: '删除申请' }).click();
    await admin.locator('[data-dialog] input').fill('QC-0000-0000');
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('编号不一致');
    await admin.getByRole('button', { name: '删除申请' }).click();
    await admin.locator('[data-dialog] input').fill(ref);
    await confirmDialog(admin);
    await expect(admin.locator('[data-toast]')).toContainText('已删除');
    await expect(admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`)).toHaveCount(0);
    expect((await browserGet(admin, href!)).status).toBe(404);
    const dir = resolve(DATA_MAIN, 'blobs', 'kyb', new URL(href!, 'http://x').searchParams.get('id')!);
    expect(existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => statSync(resolve(dir, String(f))).isFile()) : []).toEqual([]); // 文件全部删除
  });

  test('TC-K10 AC-K2 无效令牌显示"链接无效"；接口返回 404', async ({ page }) => {
    await page.goto('/onboarding/?t=not-a-valid-token-not-a-valid-token-xx');
    await expect(page.locator('[data-ob-invalid]')).toBeVisible();
    await page.goto('/onboarding/');
    await expect(page.locator('[data-ob-invalid]')).toBeVisible();
    const r = await page.request.get('/api/onboarding/state/', { headers: { 'x-kyb-token': 'nope' } });
    expect(r.status()).toBe(404);
  });

  test('TC-K11 AC-K12 定时清理接口需要 CRON_SECRET', async ({ request }) => {
    expect((await request.get('/api/cron/cleanup/')).status()).toBe(401);
    expect((await request.get('/api/cron/cleanup/', { headers: { authorization: 'Bearer wrong' } })).status()).toBe(401);
    const ok = await request.get('/api/cron/cleanup/', { headers: { authorization: `Bearer ${KYB_ENV.CRON_SECRET}` } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, deleted: 0 });
  });

  test('TC-K12 AC-K8 跨站请求（Origin 不一致）被拒绝', async () => {
    // 浏览器不允许脚本伪造 Origin，所以这里直接带上会话 Cookie 从测试端发请求
    const c = (await adminCtx.cookies()).find((x) => x.name === 'qc_admin')!;
    const r = await fetch('http://127.0.0.1:8080/api/admin/invite/', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `qc_admin=${c.value}`, origin: 'https://evil.example' }, body: JSON.stringify({ company: 'X', email: 'x@x.com' }) });
    expect(r.status).toBe(403);
    const same = await fetch('http://127.0.0.1:8080/api/admin/apps/', { headers: { cookie: `qc_admin=${c.value}` } });
    expect(same.status).toBe(200); // 同一个 Cookie 的正常请求可以通过，说明 403 来自 Origin 检查
  });

  test('TC-K13 AC-K8 连续输错 5 次后锁定（放在最后执行）', async ({ request }) => {
    for (let i = 0; i < 5; i++) expect((await request.post('/api/admin/login/', { data: { password: 'wrong', code: '000000' } })).status()).toBe(401);
    const r = await request.post('/api/admin/login/', { data: { password: PW, code: totpCode(totpSecret, Date.now()) } });
    expect(r.status()).toBe(429);
  });
});
