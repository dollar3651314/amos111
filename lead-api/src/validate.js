export const INDUSTRIES = ['export', 'manufacturing', 'b2b', 'other'];
export const VOLUMES = ['lt50k', '50k-250k', '250k-1m', 'gt1m'];
export const LANGS = ['en', 'zh'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() ]*$/;
// 除换行和制表符以外的控制字符一律拒绝，避免污染邮件和日志。
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function str(v) {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null;
}

/**
 * 校验表单数据。
 * 返回 { ok: true, data, honeypot } 或 { ok: false, errors: { 字段: 错误码 } }。
 */
export function validateLead(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { _body: 'invalid' } };
  }
  const errors = {};
  const data = {};

  const text = (field, { required, min = 1, max, singleLine = true }) => {
    const v = str(body[field]);
    if (v === null) return (errors[field] = 'invalid');
    if (v === '') {
      if (required) errors[field] = 'required';
      return;
    }
    if (v.length < min || v.length > max) return (errors[field] = 'length');
    if (CTRL_RE.test(v) || (singleLine && /[\r\n]/.test(v))) return (errors[field] = 'invalid');
    data[field] = v;
  };
  const choice = (field, options, required) => {
    const v = str(body[field]);
    if (v === '' || v === null) {
      if (required || v === null) errors[field] = v === null ? 'invalid' : 'required';
      return;
    }
    if (!options.includes(v)) return (errors[field] = 'invalid');
    data[field] = v;
  };

  text('name', { required: true, max: 100 });
  text('company', { required: true, max: 150 });
  text('email', { required: true, max: 254 });
  if (data.email && !EMAIL_RE.test(data.email)) {
    errors.email = 'format';
    delete data.email;
  }
  text('country', { required: true, min: 2, max: 100 });
  choice('industry', INDUSTRIES, true);
  choice('volume', VOLUMES, false);
  text('phone', { required: false, max: 40 });
  if (data.phone && !PHONE_RE.test(data.phone)) {
    errors.phone = 'format';
    delete data.phone;
  }
  text('message', { required: false, max: 2000, singleLine: false });
  if (body.consent !== true) errors.consent = 'required';
  else data.consent = true;
  data.lang = LANGS.includes(body.lang) ? body.lang : 'en';

  if (Object.keys(errors).length) return { ok: false, errors };
  const honeypot = typeof body.website === 'string' && body.website.trim() !== '';
  return { ok: true, data, honeypot };
}
