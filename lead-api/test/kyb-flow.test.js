import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemRedis } from '../src/kyb/memredis.js';
import { deriveKeys, decryptJson } from '../src/kyb/crypto.js';
import { createRepo } from '../src/kyb/repo.js';
import { createLocalBlobs } from '../src/kyb/blobs.js';
import { createOnboardingHandler } from '../src/kyb/onboarding.js';
import { createAdminHandler, createCleanup } from '../src/kyb/admin.js';
import { totpCode } from '../src/kyb/totp.js';

const quiet = { error() {}, warn() {} };
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]).toString('base64');
const B = 'http://kyb.test';

function setup() {
  let t = Date.parse('2026-09-28T02:00:00Z');
  const now = () => t;
  const dir = mkdtempSync(join(tmpdir(), 'kyb-'));
  const redis = createMemRedis({ now });
  const keys = deriveKeys('flow-test-secret-flow-test-secret-0123456789');
  const repo = createRepo({ redis, keys, now });
  const blobs = createLocalBlobs(join(dir, 'blobs'));
  const mails = [];
  const send = async (m) => mails.push(m);
  const config = { mailTo: 'amos@example.test', adminSetupToken: 'setup-token-123' };
  const ob = createOnboardingHandler({ repo, blobs, send, config, now, log: quiet, getIp: () => '198.51.100.7' });
  const ad = createAdminHandler({ repo, blobs, send, redis, keys, config, now, log: quiet });
  const cleanup = createCleanup({ repo, blobs, now, log: quiet });
  let cookie = '';
  const admin = async (action, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await ad(new Request(`${B}/api/admin/${action}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }));
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return [r.status, r.headers.get('content-type')?.includes('json') ? await r.json() : r];
  };
  const client = (token) => async (action, body, extra = {}) => {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-kyb-token': token, ...(extra.headers || {}) } };
    if (body !== undefined) { init.body = extra.raw ? body : JSON.stringify(body); if (!extra.raw) init.headers['content-type'] = 'application/json'; }
    const r = await ob(new Request(`${B}/api/onboarding/${action}`, init));
    return [r.status, await r.json()];
  };
  const tokenFrom = (mail) => new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('t');
  const login = async () => {
    const [s1, b1] = await admin('setup-begin/', { setupToken: 'setup-token-123', password: 'a-long-password-123' });
    assert.equal(s1, 200);
    assert.ok(b1.qr.startsWith('data:image/png;base64,'));
    assert.equal((await admin('setup-confirm/', { setupToken: 'setup-token-123', code: totpCode(b1.secret, t) }))[0], 200);
    assert.equal((await admin('login/', { password: 'a-long-password-123', code: totpCode(b1.secret, t) }))[0], 200);
    return b1.secret;
  };
  return { redis, keys, repo, blobs, mails, admin, client, tokenFrom, login, cleanup, setNow: (x) => (t = x), getNow: () => t, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const fullForm = () => ({
  entity: { legalName: 'Acme Export Limited', legalForm: 'Ltd', regNumber: '202012345K', incDate: '2020-04-18', incPlace: 'Singapore', regAddress: '10 Anson Road', physAddress: '10 Anson Road', nature: ['export'], purpose: 'deposits', volume: 'lt50k', markets: ['apac'] },
  contact: { website: 'acme.example', email: 'ops@acme.example', phone: '+65 6000 1234' },
  rep: { name: 'Jane Tan', email: 'jane@acme.example', phone: '+65 9000 1111' },
  people: [{ pid: '0', roles: ['director', 'ubo'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'SG', residence: 'SG', address: '8 Demo St', passportNo: 'K7654321Z', passportCountry: 'SG', passportExpiry: '2031-05-01', pep: 'no', email: 'jane@acme.example', phone: '+65 9000 1111' }],
  wallet: { clientName: 'Acme Export Limited', idTypeNo: 'Reg 202012345K', email: 'ops@acme.example', address: 'TXYZ123', network: 'tron', use: 'both', ownershipOk: true, riskOk: true, proofType: 'provider' },
  decl: { repName: 'Jane Tan', position: 'Director', confirm: true },
});
async function upload(c, doc, person, type = 'application/pdf', bytes = Buffer.from('%PDF-1.4 test')) {
  const q = new URLSearchParams({ doc, ...(person ? { person } : {}) });
  const [s, r] = await c(`local-upload/?${q}`, bytes, { raw: true, headers: { 'content-type': type } });
  if (s !== 200) return [s, r];
  return c('file/', { pathname: r.pathname, doc, person, name: `${doc}.pdf` });
}

test('完整流程：初始化 → 登录 → 发送链接 → 填写 → 上传 → 提交 → 补件 → 再提交 → 通过 → 删除', async () => {
  const s = setup();
  try {
    assert.equal((await s.admin('apps/'))[0], 401); // 未登录（AC-K8）
    await s.login();
    const [si, inv] = await s.admin('invite/', { company: 'Acme Export Ltd', email: 'client@acme.example' });
    assert.equal(si, 200); assert.equal(inv.emailed, true); assert.match(inv.ref, /^QC-2026-0001$/);
    assert.equal(s.mails.length, 1);
    assert.equal(s.mails[0].to, 'client@acme.example');
    assert.match(s.mails[0].text, /This is a business onboarding invitation from Quick Come/);
    const token = s.tokenFrom(s.mails[0]);
    assert.ok(token.length >= 43); // 256 位（AC-K2）
    const c = s.client(token);
    let [st, state] = await c('state/');
    assert.equal(st, 200); assert.equal(state.meta.status, 'invited'); assert.equal(state.uploadMode, 'local');

    const f = fullForm();
    for (const sec of ['entity', 'contact', 'rep', 'people', 'wallet', 'decl']) assert.equal((await c('save/', { section: sec, data: f[sec] }))[0], 200, sec);
    [, state] = await c('state/');
    assert.equal(state.meta.status, 'in_progress');
    assert.equal(state.form.entity.legalName, 'Acme Export Limited'); // 保存后可以读回（AC-K3）

    // 未上传文件就提交 → 拒绝，并指出缺少的文件（AC-K5）
    let [ss, sb] = await c('submit/', { signature: PNG });
    assert.equal(ss, 400); assert.equal(sb.fields['docs.d1'], 'required'); assert.equal(sb.fields['docs.passport:0'], 'required');
    // 文件类型不对 → 拒绝
    assert.equal((await upload(c, 'd1', undefined, 'text/html'))[0], 400);
    // 人员不存在 → 拒绝
    assert.equal((await upload(c, 'passport', '9'))[0], 400);
    for (const d of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'walletProof']) assert.equal((await upload(c, d))[0], 200, d);
    for (const d of ['passport', 'poa']) assert.equal((await upload(c, d, '0', 'image/png'))[0], 200, d);
    // 没有签名 → 拒绝（AC-K6）
    assert.equal((await c('submit/', { signature: 'data:image/png;base64,AAAA' }))[1].fields.signature, 'required');
    [ss] = await c('submit/', { signature: PNG });
    assert.equal(ss, 200);
    // 提交后：客户看不到资料、不能再保存（AC-K7）
    [, state] = await c('state/');
    assert.equal(state.meta.status, 'submitted'); assert.equal(state.form, undefined);
    assert.equal((await c('save/', { section: 'entity', data: f.entity }))[0], 409);
    // 通知 Amos：不含敏感字段（AC-K7）
    const note = s.mails.at(-1);
    assert.equal(note.to, 'amos@example.test');
    for (const secret of ['K7654321Z', '8 Demo St', 'client@acme.example', 'jane@acme.example']) assert.ok(!note.text.includes(secret), secret);

    // 数据库里是密文（AC-K10a）
    const raw = JSON.stringify(s.redis.raw());
    for (const secret of ['K7654321Z', '8 Demo St', 'jane@acme.example', 'client@acme.example', 'Acme Export Limited']) assert.ok(!raw.includes(secret), `明文泄露：${secret}`);
    assert.ok(!raw.includes(token), '令牌明文不应存储');

    // 后台查看详情、下载文件（AC-K9）
    const [, list] = await s.admin('apps/');
    const id = list.apps[0].id;
    assert.equal(list.apps[0].status, 'submitted');
    const [, detail] = await s.admin(`app/?id=${id}`);
    assert.equal(detail.form.people[0].passportNo, 'K7654321Z');
    assert.equal(detail.signature.ip, '198.51.100.7');
    assert.equal(detail.files.length, 9);
    const [fs, fr] = await s.admin(`file/?id=${id}&fileId=${detail.files[0].id}`);
    assert.equal(fs, 200); assert.equal(await fr.text(), '%PDF-1.4 test');
    assert.match(fr.headers.get('content-disposition'), /^attachment/);

    // 要求补件：只开放"文件"部分
    const [ns, nb] = await s.admin('decide/', { id, action: 'needs_info', sections: ['docs'], message: '存续证明需要 90 天内签发' });
    assert.equal(ns, 200); assert.equal(nb.emailed, true);
    assert.equal((await c('state/'))[0], 404); // 旧链接失效
    const token2 = s.tokenFrom(s.mails.at(-1));
    assert.match(s.mails.at(-1).text, /存续证明需要 90 天内签发/);
    const c2 = s.client(token2);
    [, state] = await c2('state/');
    assert.deepEqual(state.editable.sort(), ['decl', 'docs']);
    assert.equal((await c2('save/', { section: 'entity', data: f.entity }))[0], 403); // 未开放的部分不能改
    const oldD2 = state.files.find((x) => x.doc === 'd2');
    assert.equal((await c2('file-delete/', { fileId: oldD2.id }))[0], 200);
    assert.equal((await upload(c2, 'd2'))[0], 200);
    assert.equal((await c2('submit/', { signature: PNG }))[0], 200);
    assert.match(s.mails.at(-1).subject, /resubmitted/);

    // 通过 → 保留期：业务关系存续期间一直保留
    assert.equal((await s.admin('decide/', { id, action: 'approve' }))[0], 200);
    let [, d2] = await s.admin(`app/?id=${id}`);
    assert.equal(d2.app.status, 'approved'); assert.equal(d2.app.retentionUntil, null); assert.equal(d2.review.reviewer, 'Amos');
    assert.ok(d2.audit.map((x) => x.action).join(',').includes('needs_info,resubmitted,approved'));

    // 删除：申请和全部文件都查不到（AC-K12）
    assert.equal((await s.admin('delete/', { id, confirmRef: 'wrong' }))[0], 400);
    assert.equal((await s.admin('delete/', { id, confirmRef: inv.ref }))[0], 200);
    assert.equal((await s.admin(`app/?id=${id}`))[0], 404);
    const left = existsSync(join(s.dir, 'blobs', 'kyb', id)) ? readdirSync(join(s.dir, 'blobs', 'kyb', id)) : [];
    assert.deepEqual(left, []);
  } finally { s.done(); }
});

test('安全：一个客户的链接不能访问另一个申请的文件；无效令牌 404；未登录不能下载', async () => {
  const s = setup();
  try {
    await s.login();
    await s.admin('invite/', { company: 'A', email: 'a@a.com' });
    await s.admin('invite/', { company: 'B', email: 'b@b.com' });
    const [ta, tb] = [s.tokenFrom(s.mails[0]), s.tokenFrom(s.mails[1])];
    const ca = s.client(ta), cb = s.client(tb);
    const [, stA] = await ca('state/');
    const [, up] = await ca('local-upload/?doc=d1', Buffer.from('%PDF'), { raw: true, headers: { 'content-type': 'application/pdf' } });
    // B 试图把 A 的文件登记到自己名下 → 拒绝
    assert.equal((await cb('file/', { pathname: up.pathname, doc: 'd1', name: 'x.pdf' }))[0], 400);
    assert.ok(up.pathname.startsWith(stA.uploadPrefix));
    assert.equal((await s.client('not-a-real-token-not-a-real-token-xx')('state/'))[0], 404);
    assert.equal((await s.client('')('state/'))[0], 404);
    // 退出登录后，旧会话失效
    assert.equal((await s.admin('logout/', {}))[0], 200);
    assert.equal((await s.admin('apps/'))[0], 401);
  } finally { s.done(); }
});

test('登录锁定：连续错误 5 次锁定 15 分钟（AC-K8）', async () => {
  const s = setup();
  try {
    const secret = await s.login();
    await s.admin('logout/', {});
    for (let i = 0; i < 5; i++) assert.equal((await s.admin('login/', { password: 'wrong', code: '000000' }))[0], 401);
    const [ls, lb] = await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) });
    assert.equal(ls, 429); assert.equal(lb.error, 'locked');
    s.setNow(s.getNow() + 15 * 60 * 1000 + 1000);
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) }))[0], 200);
  } finally { s.done(); }
});

test('初始化：口令错误、密码太短、重复初始化都被拒绝', async () => {
  const s = setup();
  try {
    assert.equal((await s.admin('setup-begin/', { setupToken: 'nope', password: 'a-long-password-123' }))[0], 403);
    assert.equal((await s.admin('setup-begin/', { setupToken: 'setup-token-123', password: 'short' }))[0], 400);
    await s.login();
    assert.equal((await s.admin('setup-begin/', { setupToken: 'setup-token-123', password: 'a-long-password-123' }))[0], 409);
  } finally { s.done(); }
});

test('链接 30 天过期；重新发送后旧链接失效、新链接可用（AC-K2）', async () => {
  const s = setup();
  try {
    const secret = await s.login();
    await s.admin('invite/', { company: 'Late Co', email: 'late@x.com' });
    const t0 = s.tokenFrom(s.mails.at(-1));
    assert.equal((await s.client(t0)('state/'))[0], 200);
    s.setNow(s.getNow() + 31 * 864e5);
    assert.equal((await s.client(t0)('state/'))[0], 404); // 过期
    assert.equal((await s.admin('apps/'))[0], 401); // 会话 8 小时后过期
    assert.equal((await s.admin('login/', { password: 'a-long-password-123', code: totpCode(secret, s.getNow()) }))[0], 200);
    const [, list] = await s.admin('apps/');
    assert.equal(list.apps[0].status, 'expired');
    assert.equal((await s.admin('resend/', { id: list.apps[0].id }))[0], 200);
    const t1 = s.tokenFrom(s.mails.at(-1));
    assert.notEqual(t1, t0);
    assert.equal((await s.client(t0)('state/'))[0], 404);
    const [st, body] = await s.client(t1)('state/');
    assert.equal(st, 200); assert.equal(body.meta.status, 'invited');
  } finally { s.done(); }
});

test('自动清理：未通过的申请满 1 年删除；通过且业务关系结束满 5 年删除', async () => {
  const s = setup();
  try {
    const { app: a1 } = await s.repo.create({ company: 'Old', email: 'o@x.com' });
    const { app: a2 } = await s.repo.create({ company: 'Client', email: 'c@x.com' });
    a2.status = 'approved'; await s.repo.save(a2);
    s.setNow(s.getNow() + 366 * 864e5);
    assert.deepEqual(await s.cleanup(), { deleted: 1 });
    assert.equal(await s.repo.get(a1.id), null);
    const cur = await s.repo.get(a2.id);
    cur.relationshipEndedAt = new Date(s.getNow()).toISOString(); await s.repo.save(cur);
    s.setNow(s.getNow() + 5 * 366 * 864e5);
    assert.deepEqual(await s.cleanup(), { deleted: 1 });
    assert.equal(await s.repo.get(a2.id), null);
  } finally { s.done(); }
});

test('原始存储中的申请记录只有明文的编号、状态、企业名称', async () => {
  const s = setup();
  try {
    const { app } = await s.repo.create({ company: 'Visible Co', email: 'secret-mail@x.com' });
    const raw = s.redis.raw().kv[`qc:app:${app.id}`];
    assert.ok(raw.includes('Visible Co')); assert.ok(!raw.includes('secret-mail@x.com'));
    assert.equal(decryptJson(s.keys.enc, JSON.parse(raw).enc).email, 'secret-mail@x.com');
  } finally { s.done(); }
});
