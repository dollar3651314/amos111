import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonl, decodeQP, MAILS, DATA_MAIN, KYB_ENV, ROOT } from '../stack.mjs';
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
let leadsBefore = 0;
let adminCtx: BrowserContext;
let admin: Page;

const mailsTo = (addr: string) => readJsonl(MAILS).filter((m: any) => m.to.includes(addr)).map((m: any) => decodeQP(m.raw));
const linkIn = (mail: string) => mail.match(/https?:\/\/[^\s]+\/onboarding\/\?t=[A-Za-z0-9_-]+/)![0];
const cspErrors = (page: Page) => { const errs: string[] = []; page.on('console', (m) => /Content Security Policy/i.test(m.text()) && errs.push(m.text())); return errs; };

// SHOTS=1 时保存交付说明用的截图（正式构建、真实接口，不是原型）
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: resolve(ROOT, 'assets/v3', `实现-${name}.png`), fullPage: false }); };
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
    const again = await admin.request.post('/api/kyb/?g=admin&a=setup-begin', { data: { setupToken: KYB_ENV.ADMIN_SETUP_TOKEN, password: PW } });
    expect(again.status()).toBe(409);
    expect(errs).toEqual([]);
  });

  test('TC-K02 AC-K8 登录：密码或动态码错误被拒绝；正确后进入后台；会话 Cookie 为 HttpOnly', async () => {
    await admin.goto('/admin/');
    await admin.fill('#a-pw', PW); await admin.fill('#a-otp', '123456');
    await admin.click('[data-login] button[type="submit"]');
    await expect(admin.locator('[data-login-err]')).toBeVisible();
    await login(admin);
    // BUG-K9：导航上的数字登录后立即显示，0 也显示为"0"
    await expect(admin.locator('[data-count="apps"]')).toHaveText('0');
    await expect(admin.locator('[data-apps-body]')).toContainText('暂无申请'); // 空状态（AC-V10）
    await expect(admin.locator('[data-count="leads"]')).toHaveText(/^\d+$/); // 前面的用例已经提交过线索
    leadsBefore = Number(await admin.locator('[data-count="leads"]').textContent());
    await expect(admin.locator('[data-count="apps"]')).toHaveAttribute('title', '待审核（已提交）：0');
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
    await page.check('[name="entity.purpose"][value="crypto"]'); // v4：多选（AC-V4）
    // v4：月交易量没有"其他"；选 50 万以上要写金额（AC-V5）
    await expect(page.locator('[name="entity.volume"][value="other"]')).toHaveCount(0);
    await page.check('[name="entity.volume"][value="gt500k"]');
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.volumeAmount"]')).not.toBeEmpty();
    await page.fill('[name="entity.volumeAmount"]', 'USD 800,000');
    // v4：币种必填，选"其他"要注明（AC-V1）
    await expect(page.locator('[data-err-for="entity.currencies"]')).not.toBeEmpty();
    await page.check('[name="entity.currencies"][value="usdt"]');
    await page.check('[name="entity.currencies"][value="other"]');
    await page.fill('[name="entity.currenciesOther"]', 'TRX');
    await page.check('[name="entity.markets"][value="apac"]');
    // v4：制裁声明必填，选"是"要写说明（AC-V2）
    await expect(page.locator('[data-err-for="entity.sanctions"]')).not.toBeEmpty();
    await page.check('[name="entity.sanctions"][value="yes"]');
    await page.click('[data-next]');
    await expect(page.locator('[data-err-for="entity.sanctionsDetails"]')).not.toBeEmpty();
    await page.fill('[name="entity.sanctionsDetails"]', 'SANCTION-DETAIL-E2E: limited exposure, under USD 5,000 per month');
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
    await expect(p.locator('[data-ubo-fields]')).toBeHidden(); // v4：不是 UBO 时不显示持股比例（AC-V3）
    await p.locator('[name$=".roles"][value="ubo"]').check();
    await expect(p.locator('[data-ubo-fields]')).toBeVisible();
    await p.locator('[name$=".ownershipPct"]').fill('120');
    await p.locator('[name$=".votingPct"]').fill('75.5');
    for (const [k, v] of Object.entries({ fullName: 'Nguyen Thi Lan', dob: '1985-06-01', nationality: 'Vietnam', residence: 'Vietnam', address: '5 Le Loi, District 1', passportNo: 'C9876543', passportCountry: 'Vietnam', passportExpiry: '2032-01-31', email: CLIENT, phone: '+84 90 123 4567' }))
      await p.locator(`[name$=".${k}"]`).fill(v);
    await p.locator('[name$=".pep"][value="yes"]').check();
    await expect(p.locator('[data-pep-details]')).toBeVisible(); // 选"是"时要求说明
    await p.locator('[name$=".pep"][value="no"]').check();
    await page.click('[data-next]');
    await expect(p.locator('[data-err-for$=".ownershipPct"]')).toHaveText(/0 to 100/);
    await p.locator('[name$=".ownershipPct"]').fill('75.5');
    await next(page, 4);
    // v4：第 ⑤ 步不再有第 11、12 项（AC-V6）
    await expect(page.locator('[data-doc="d11"], [data-doc="d12"]')).toHaveCount(0);
    await expect(page.locator('[data-step="4"]')).not.toContainText('Appendix');

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
    await shot(page, '客户提交成功');

    // 提交后同一链接只能看到"已提交"（AC-K7）
    await page.goto(link);
    await expect(page.locator('[data-ob-done]')).toBeVisible();
    await expect(page.locator('#ob-form')).toBeHidden();
    expect(errs).toEqual([]);
    await ctx.close();

    // Amos 收到通知，但通知里没有敏感信息
    // 通知邮件在提交返回之后才异步发送（waitUntil）：等邮件到了再检查，不要马上读
    await expect.poll(() => mailsTo('sales@quickcomepay.test').filter((m) => m.includes(ref)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const note = mailsTo('sales@quickcomepay.test').filter((m) => m.includes(ref)).at(-1)!;
    for (const s of ['C9876543', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE']) expect(note).not.toContain(s);
  });

  test('TC-K05 AC-K10 存储中只有密文：护照号、地址、邮箱、钱包地址都不以明文出现', async () => {
    const raw = readFileSync(resolve(DATA_MAIN, 'kyb-redis.json'), 'utf8');
    expect(raw).toContain(ref);
    for (const s of ['C9876543', '5 Le Loi', 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', 'Mekong Export Company Limited', 'Nguyen Thi Lan', 'SANCTION-DETAIL-E2E', 'USD 800,000']) expect(raw).not.toContain(s); // v4 新字段同样加密（AC-V9）
  });

  test('TC-K06 AC-K9 后台查看完整资料、下载文件、查看签名', async () => {
    await admin.reload();
    await expect(admin.locator('[data-view="app"]')).toBeVisible();
    await expect(admin.locator('[data-count="apps"]')).toHaveText('1'); // 1 个待审核
    await expect(admin.locator('[data-count="leads"]')).toHaveText(String(leadsBefore)); // 新线索已发送链接，未发送的数量不变
    const row = admin.locator(`[data-apps-body] tr[data-ref="${ref}"]`);
    await expect(row).toContainText('已提交');
    await expect(row).toContainText('涉及制裁：是'); // v4：红色标记（AC-V7）
    await row.click();
    await expect(admin.locator('[data-detail-sections]')).toContainText('Mekong Export Company Limited');
    const sections = admin.locator('[data-detail-sections]');
    await expect(sections.locator('.flag-sanctions')).toBeVisible();
    for (const t of ['USDT、其他：TRX', 'USD 800,000', 'SANCTION-DETAIL-E2E', '75.5%', '接受客户的加密货币付款']) await expect(sections).toContainText(t);
    await expect(admin.locator('[data-detail-sections]')).toContainText('C9876543');
    await expect(admin.locator('[data-side]')).toContainText(CLIENT);
    const sig = admin.getByRole('img', { name: '客户手写签名' });
    await expect(sig).toBeVisible();
    await expect.poll(() => sig.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // 签名图片在 CSP 下能正常加载
    await admin.setViewportSize({ width: 1280, height: 900 }); await shot(admin, '后台详情-已提交');
    const href = await admin.locator('.file-link a').first().getAttribute('href');
    // 在浏览器里下载（与 Amos 点击链接相同，带 HttpOnly 会话 Cookie）
    const res = await browserGet(admin, href!);
    expect(res.status).toBe(200);
    expect(res.disposition).toMatch(/^attachment/);
    expect(res.text).toContain('%PDF-1.4');
    // 未登录不能下载、不能看列表
    const anon = await admin.context().browser()!.newContext({ baseURL: 'http://127.0.0.1:8080' });
    expect((await anon.request.get(href!)).status()).toBe(401);
    expect((await anon.request.get('/api/kyb/?g=admin&a=apps')).status()).toBe(401);
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
    await page.setViewportSize({ width: 375, height: 812 }); await shot(page, '客户补件-直接打开被开放的步骤-手机');
    await page.setViewportSize({ width: 1280, height: 720 });
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
    // 审核后导航上的"待审核"数字马上更新，不需要刷新页面（BUG-P7）
    await expect(admin.locator('[data-count="apps"]')).toHaveText('0');
    await shot(admin, '后台详情-已通过');
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
    const r = await page.request.get('/api/kyb/?g=onboarding&a=state', { headers: { 'x-kyb-token': 'nope' } });
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
    const r = await fetch('http://127.0.0.1:8080/api/kyb/?g=admin&a=invite', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `qc_admin=${c.value}`, origin: 'https://evil.example' }, body: JSON.stringify({ company: 'X', email: 'x@x.com' }) });
    expect(r.status).toBe(403);
    const same = await fetch('http://127.0.0.1:8080/api/kyb/?g=admin&a=apps', { headers: { cookie: `qc_admin=${c.value}` } });
    expect(same.status).toBe(200); // 同一个 Cookie 的正常请求可以通过，说明 403 来自 Origin 检查
  });

  test('TC-K14 AC-K11 AC-K5 切换语言不丢失未保存的内容；超过 10MB 的文件被拒绝', async ({ browser }) => {
    const email = 'lang-switch@mekong.example';
    const r = await admin.evaluate(async (em) => (await fetch('/api/kyb/?g=admin&a=invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Lang Switch Co', email: em }) })).status, email);
    expect(r).toBe(200);
    const link = linkIn(mailsTo(email).at(-1)!);
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
    const page = await ctx.newPage();
    await page.goto(link);
    await page.fill('[name="entity.legalName"]', 'Unsaved Before Switch Ltd');
    await page.click('a[data-keep-query]');
    await expect(page).toHaveURL(/\/zh\/onboarding\/\?t=.+#step-0$/);
    await expect(page.locator('[name="entity.legalName"]')).toHaveValue('Unsaved Before Switch Ltd');
    await expect(page.locator('[data-step="0"] h2')).toHaveText(/企业信息/);
    // 超过 10MB：服务端拒绝（前端也会提示）
    const token = new URL(link).searchParams.get('t')!;
    const big = await fetch('http://127.0.0.1:8080/api/kyb/?g=onboarding&a=local-upload&doc=d1', { method: 'POST', headers: { 'x-kyb-token': token, 'content-type': 'application/pdf' }, body: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
    await ctx.close();
  });

  test('TC-K17 BUG-K7 旧的接口地址已不存在（与线上一致返回 404）', async ({ request }) => {
    expect((await request.get('/api/admin/me/')).status()).toBe(404);
    expect((await request.get('/api/kyb/?g=nope&a=me')).status()).toBe(404);
  });

  test('TC-K13 AC-K8 连续输错 5 次后锁定（放在最后执行）', async ({ request }) => {
    for (let i = 0; i < 5; i++) expect((await request.post('/api/kyb/?g=admin&a=login', { data: { password: 'wrong', code: '000000' } })).status()).toBe(401);
    const r = await request.post('/api/kyb/?g=admin&a=login', { data: { password: PW, code: totpCode(totpSecret, Date.now()) } });
    expect(r.status()).toBe(429);
  });
});

// TC-K15 AC-K14 隐私政策中英两版都有 KYB 数据一节
for (const [path, title] of [['/privacy/', 'Business onboarding (KYB)'], ['/zh/privacy/', '企业开户资料（KYB）']]) {
  test(`TC-K15 AC-K14 ${path} 含 KYB 一节`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  });
}

// TC-K16 AC-K15 开户页和后台在三种宽度下没有横向滚动（原型构建，表单可见）
for (const w of [375, 768, 1280]) {
  for (const path of ['/onboarding/?t=demo', '/zh/onboarding/?t=demo', '/admin/']) {
    test(`TC-K16 AC-K15 ${w}px ${path} 无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto('http://127.0.0.1:8090' + path);
      await page.waitForLoadState('networkidle');
      if (path.includes('onboarding')) {
        // 前端校验会阻止跳到后面的步骤，所以直接把 7 个步骤同时显示出来，一次检查全部内容
        await page.evaluate(() => document.querySelectorAll('[data-step]').forEach((e) => e.removeAttribute('hidden')));
        await expect(page.locator('[data-step="6"]')).toBeVisible();
        await page.click('[data-add-person]'); // 两个人员卡片
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  }
}
