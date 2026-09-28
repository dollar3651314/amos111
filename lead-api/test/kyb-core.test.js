import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKeys, encryptJson, decryptJson, newToken, hashToken } from '../src/kyb/crypto.js';
import { totpCode, verifyTotp, base32Encode, base32Decode } from '../src/kyb/totp.js';
import { hashPassword, verifyPassword, makeSession, readSession } from '../src/kyb/auth.js';
import { validateSection, validateForSubmit } from '../src/kyb/schema.js';

const SECRET = 'unit-test-secret-unit-test-secret-0123456789';

test('加密：往返正确；每次密文不同；篡改后解密失败；错误密钥无法解密', () => {
  const k = deriveKeys(SECRET);
  const v = { passport: 'K1234567X', nested: [1, 2, { a: '中文' }] };
  const c1 = encryptJson(k.enc, v), c2 = encryptJson(k.enc, v);
  assert.notEqual(c1, c2);
  assert.deepEqual(decryptJson(k.enc, c1), v);
  assert.ok(!c1.includes('K1234567X'));
  const parts = c1.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decryptJson(k.enc, parts.join('.')));
  assert.throws(() => decryptJson(deriveKeys(SECRET + 'x').enc, c1));
  assert.throws(() => deriveKeys('short'));
});

test('令牌：256 位随机，哈希与密钥相关', () => {
  const k = deriveKeys(SECRET);
  const t = newToken();
  assert.ok(Buffer.from(t, 'base64url').length === 32);
  assert.equal(hashToken(k.token, t), hashToken(k.token, t));
  assert.notEqual(hashToken(k.token, t), hashToken(deriveKeys(SECRET + 'y').token, t));
});

test('TOTP：通过 RFC 6238 官方测试向量（SHA1）；允许 ±30 秒误差', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 附录 B：T=59 → 94287082，T=1111111109 → 07081804（取后 6 位）
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
  assert.equal(totpCode(secret, 20000000000_000), '353130');
  const t = 1_800_000_000_000;
  assert.ok(verifyTotp(secret, totpCode(secret, t), t));
  assert.ok(verifyTotp(secret, totpCode(secret, t - 30_000), t));
  assert.ok(!verifyTotp(secret, totpCode(secret, t - 120_000), t));
  assert.ok(!verifyTotp(secret, 'abc123', t));
});

test('密码哈希与会话：错误密码失败；会话过期、被篡改、版本变化后失效', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  const k = deriveKeys(SECRET);
  const now = 1_800_000_000_000;
  const s = makeSession(k.session, 3, now);
  assert.ok(readSession(k.session, `a=1; qc_admin=${s}`, 3, now + 1000));
  assert.equal(readSession(k.session, `qc_admin=${s}`, 3, now + 8 * 3600e3 + 1), null);
  assert.equal(readSession(k.session, `qc_admin=${s}`, 4, now), null);
  assert.equal(readSession(k.session, `qc_admin=${s.slice(0, -1)}x`, 3, now), null);
  assert.equal(readSession(k.session, 'qc_admin=garbage', 3, now), null);
});

const person = (o = {}) => ({ pid: '0', roles: ['director', 'ubo'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'SG', residence: 'SG', address: 'x', passportNo: 'K1', passportCountry: 'SG', passportExpiry: '2031-05-01', pep: 'no', email: 'j@a.com', phone: '+65 9000 1111', ...o });

test('字段校验：草稿只拦截非法内容，提交时严格校验', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  assert.deepEqual(validateSection('entity', { legalName: '' }, { now }).errors, {});
  assert.equal(validateSection('entity', { legalName: 'A\nB' }, { now }).errors['entity.legalName'], 'invalid');
  assert.equal(validateSection('entity', { nature: ['casino'] }, { now }).errors['entity.nature'], 'invalid');
  const strict = validateSection('entity', { nature: ['other'] }, { strict: true, now }).errors;
  assert.equal(strict['entity.legalName'], 'required');
  assert.equal(strict['entity.natureOther'], 'required');
  assert.equal(validateSection('contact', { email: 'bad', phone: 'call me' }, { strict: true, now }).errors['contact.email'], 'email');
  const p = validateSection('people', [person({ passportExpiry: '2026-01-01', pep: 'yes' })], { strict: true, now }).errors;
  assert.equal(p['people.0.passportExpiry'], 'future');
  assert.equal(p['people.0.pepDetails'], 'required');
  assert.equal(validateSection('people', [person({ roles: ['director'] })], { strict: true, now }).errors.people, 'people');
  assert.equal(validateSection('people', [person()], { strict: true, now }).errors.people, undefined);
});

test('提交校验：必传文件（企业 1 到 6 项、每人护照和地址证明、钱包证明）', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const form = { people: [person()] };
  const errs = validateForSubmit(form, [], now);
  for (const k of ['docs.d1', 'docs.d6', 'docs.passport:0', 'docs.poa:0', 'docs.walletProof']) assert.equal(errs[k], 'required', k);
  assert.equal(errs['docs.d10'], undefined);
  const files = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'walletProof'].map((doc) => ({ doc })).concat([{ doc: 'passport', person: '0' }, { doc: 'poa', person: '0' }]);
  const e2 = validateForSubmit(form, files, now);
  assert.equal(Object.keys(e2).filter((k) => k.startsWith('docs.')).length, 0);
});
