import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLead } from '../src/validate.js';

const valid = () => ({
  name: 'Jane Doe',
  company: 'Acme Export Ltd',
  email: 'jane@acme.com',
  country: 'Vietnam',
  industry: 'export',
  consent: true,
});

test('接受最小合法输入并去除首尾空格', () => {
  const r = validateLead({ ...valid(), name: '  Jane Doe  ' });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, 'Jane Doe');
  assert.equal(r.data.lang, 'en');
  assert.equal(r.honeypot, false);
});

test('缺少必填项时报 required', () => {
  const r = validateLead({ consent: true });
  assert.equal(r.ok, false);
  for (const f of ['name', 'company', 'email', 'country', 'industry']) assert.equal(r.errors[f], 'required');
});

test('未勾选同意隐私政策时拒绝', () => {
  assert.equal(validateLead({ ...valid(), consent: 'true' }).errors.consent, 'required');
});

test('邮箱格式、下拉选项、电话格式校验', () => {
  assert.equal(validateLead({ ...valid(), email: 'not-an-email' }).errors.email, 'format');
  assert.equal(validateLead({ ...valid(), industry: 'crypto' }).errors.industry, 'invalid');
  assert.equal(validateLead({ ...valid(), volume: '999' }).errors.volume, 'invalid');
  assert.equal(validateLead({ ...valid(), phone: 'call me' }).errors.phone, 'format');
  assert.equal(validateLead({ ...valid(), phone: '+84 (0) 123-456' }).ok, true);
});

test('长度限制', () => {
  assert.equal(validateLead({ ...valid(), name: 'x'.repeat(101) }).errors.name, 'length');
  assert.equal(validateLead({ ...valid(), message: 'x'.repeat(2001) }).errors.message, 'length');
  assert.equal(validateLead({ ...valid(), country: 'V' }).errors.country, 'length');
});

test('单行字段拒绝换行（防邮件头注入），留言允许换行', () => {
  assert.equal(validateLead({ ...valid(), company: 'Acme\r\nBcc: x@y.z' }).errors.company, 'invalid');
  assert.equal(validateLead({ ...valid(), message: 'line1\nline2' }).ok, true);
});

test('非字符串类型报 invalid', () => {
  assert.equal(validateLead({ ...valid(), name: { a: 1 } }).errors.name, 'invalid');
  assert.equal(validateLead([]).ok, false);
  assert.equal(validateLead(null).ok, false);
});

test('蜜罐字段非空时标记 honeypot', () => {
  assert.equal(validateLead({ ...valid(), website: 'http://spam' }).honeypot, true);
});
