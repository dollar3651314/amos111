// 开户资料的服务端校验。规则与前端（site/src/scripts/onboarding.ts）一致；服务端是最终依据（AC-K4、AC-K5）。
export const SECTIONS = ['entity', 'contact', 'rep', 'people', 'docs', 'wallet', 'decl'];
export const COMPANY_DOCS_REQUIRED = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
// v4：删除第 11、12 项（资金来源类证明）。已上传的旧文件保留在申请里，后台照常可以下载
export const COMPANY_DOCS_OPTIONAL = ['d10', 'd13', 'd14', 'd15', 'd16'];
export const DOC_IDS = new Set([...COMPANY_DOCS_REQUIRED, ...COMPANY_DOCS_OPTIONAL, 'passport', 'poa', 'walletProof']);
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PEOPLE = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() ]{5,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 0 到 100，最多 2 位小数（UBO 的持股比例和投票权比例）
const PCT_RE = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const F = (type, required, extra = {}) => ({ type, required, ...extra });
const ENTITY = {
  legalName: F('text', true), tradingName: F('text', false), legalForm: F('text', true), regNumber: F('text', true),
  incDate: F('date', true, { past: true }), incPlace: F('text', true), regAddress: F('long', true), physAddress: F('long', true),
  lei: F('text', false), tin: F('text', false),
  nature: F('multi', true, { options: ['export', 'manufacturing', 'b2b', 'cfd', 'securities', 'fx', 'other'] }), natureOther: F('text', false),
  // v4：业务用途改为 4 个选项、多选；月交易量去掉"其他"，50 万以上要写金额；新增币种和制裁声明
  purpose: F('multi', true, { options: ['crypto', 'exchange', 'deposits', 'other'] }), purposeOther: F('text', false),
  volume: F('choice', true, { options: ['lt50k', '50k-100k', '100k-500k', 'gt500k'] }), volumeAmount: F('text', false),
  currencies: F('multi', true, { options: ['usd', 'eur', 'usdt', 'usdc', 'btc', 'eth', 'other'] }), currenciesOther: F('text', false),
  markets: F('multi', true, { options: ['europe', 'na', 'latam', 'uk', 'me', 'apac', 'other'] }), marketsOther: F('text', false),
  sanctions: F('choice', true, { options: ['yes', 'no'] }), sanctionsDetails: F('long', false),
  parent: F('text', false),
};
const CONTACT = { website: F('text', true), email: F('email', true), phone: F('tel', true), otherContact: F('text', false) };
const REP = { name: F('text', true), email: F('email', true), phone: F('tel', true), otherContact: F('text', false) };
const PERSON = {
  roles: F('multi', true, { options: ['director', 'ubo', 'signatory'] }), fullName: F('text', true), dob: F('date', true, { past: true }),
  nationality: F('text', true), residence: F('text', true), address: F('long', true), passportNo: F('text', true),
  passportCountry: F('text', true), passportExpiry: F('date', true, { future: true }),
  ownershipPct: F('percent', false), votingPct: F('percent', false), // v4：勾选 UBO 时必填
  pep: F('choice', true, { options: ['yes', 'no'] }),
  pepDetails: F('long', false), email: F('email', true), phone: F('tel', true),
};
const WALLET = {
  clientName: F('text', true), idTypeNo: F('text', true), userId: F('text', false), email: F('email', true), address: F('text', true),
  network: F('choice', true, { options: ['tron', 'ethereum', 'other'] }), networkOther: F('text', false),
  use: F('choice', true, { options: ['deposit', 'withdrawal', 'both'] }),
  ownershipOk: F('bool', true), riskOk: F('bool', true),
  proofType: F('choice', true, { options: ['provider', 'explorer', 'other'] }), proofTypeOther: F('text', false),
};
const DECL = { repName: F('text', true), position: F('text', true), confirm: F('bool', true) };
export const SCHEMA = { entity: ENTITY, contact: CONTACT, rep: REP, wallet: WALLET, decl: DECL };

/** 清洗单个字段：去掉未知字段、限制长度和类型。返回 [值, 错误码] */
function clean(spec, v, { strict, today }) {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;
  if (empty) return [spec.type === 'multi' ? [] : spec.type === 'bool' ? false : '', strict && spec.required ? 'required' : null];
  switch (spec.type) {
    case 'bool': return [v === true, v === true ? null : 'invalid'];
    case 'multi': {
      if (typeof v === 'string') v = [v]; // v3 的单选值（例如业务用途 "deposits"）按一个选项处理
      if (!Array.isArray(v) || v.some((x) => !spec.options.includes(x))) return [[], 'invalid'];
      return [[...new Set(v)], null];
    }
    case 'choice': return spec.options.includes(v) ? [v, null] : ['', 'invalid'];
    default: {
      if (typeof v !== 'string') return ['', 'invalid'];
      const s = v.trim();
      const max = spec.type === 'long' ? 2000 : 300;
      if (s.length > max) return [s.slice(0, max), 'length'];
      if (CTRL_RE.test(s) || (spec.type !== 'long' && /[\r\n]/.test(s))) return ['', 'invalid'];
      if (spec.type === 'percent' && !PCT_RE.test(s)) return [s, 'percent'];
      if (spec.type === 'email' && !EMAIL_RE.test(s)) return [s, strict ? 'email' : null];
      if (spec.type === 'tel' && !PHONE_RE.test(s)) return [s, strict ? 'phone' : null];
      if (spec.type === 'date') {
        if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return [s, strict ? 'date' : null];
        if (strict && spec.future && s <= today) return [s, 'future'];
        if (strict && spec.past && s > today) return [s, 'date'];
      }
      return [s, null];
    }
  }
}

function cleanGroup(specs, input, opts, prefix, errors) {
  const out = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const [k, spec] of Object.entries(specs)) {
    const [v, err] = clean(spec, src[k], opts);
    out[k] = v;
    if (err && (opts.strict || err === 'invalid' || err === 'length')) errors[`${prefix}.${k}`] = err;
  }
  // "其他"被选中时必须注明
  if (opts.strict) {
    for (const k of Object.keys(specs)) {
      const v = out[k];
      const picked = Array.isArray(v) ? v.includes('other') : v === 'other';
      if (picked && specs[`${k}Other`] && !out[`${k}Other`]) errors[`${prefix}.${k}Other`] = 'required';
    }
  }
  return out;
}

/**
 * 校验一个步骤的数据。strict=false 用于"保存草稿"（只拦截非法类型和超长内容），strict=true 用于"提交"。
 * 返回 { data, errors }
 */
export function validateSection(section, input, { strict = false, now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const opts = { strict, today };
  const errors = {};
  if (section === 'people') {
    const list = Array.isArray(input) ? input.slice(0, MAX_PEOPLE) : [];
    const data = list.map((p, i) => {
      const o = cleanGroup(PERSON, p, opts, `people.${i}`, errors);
      o.pid = typeof p?.pid === 'string' && /^[a-z0-9]{1,16}$/.test(p.pid) ? p.pid : String(i);
      if (strict && o.pep === 'yes' && !o.pepDetails) errors[`people.${i}.pepDetails`] = 'required';
      // v4：只有 UBO 填写持股比例和投票权比例；不是 UBO 时清空，不保存
      if (o.roles.includes('ubo')) {
        for (const k of ['ownershipPct', 'votingPct']) if (strict && !o[k]) errors[`people.${i}.${k}`] = 'required';
      } else { o.ownershipPct = ''; o.votingPct = ''; delete errors[`people.${i}.ownershipPct`]; delete errors[`people.${i}.votingPct`]; }
      return o;
    });
    if (strict) {
      if (!data.some((p) => p.roles.includes('director')) || !data.some((p) => p.roles.includes('ubo'))) errors.people = 'people';
    }
    return { data, errors };
  }
  if (!SCHEMA[section]) return { data: null, errors: { _section: 'invalid' } };
  const data = cleanGroup(SCHEMA[section], input, opts, section, errors);
  if (section === 'entity') {
    // v4：按选择才需要填写的字段；不适用时清空
    if (data.volume === 'gt500k') { if (strict && !data.volumeAmount) errors['entity.volumeAmount'] = 'required'; } else data.volumeAmount = '';
    if (data.sanctions === 'yes') { if (strict && !data.sanctionsDetails) errors['entity.sanctionsDetails'] = 'required'; } else data.sanctionsDetails = '';
  }
  return { data, errors };
}

/** 提交前的整体校验：全部步骤 + 必传文件 */
export function validateForSubmit(form, files, now = Date.now()) {
  const errors = {};
  for (const s of ['entity', 'contact', 'rep', 'people', 'wallet', 'decl']) Object.assign(errors, validateSection(s, form?.[s], { strict: true, now }).errors);
  const has = (doc, person) => files.some((f) => f.doc === doc && (person === undefined || f.person === person));
  for (const d of COMPANY_DOCS_REQUIRED) if (!has(d)) errors[`docs.${d}`] = 'required';
  for (const p of form?.people || []) for (const d of ['passport', 'poa']) if (!has(d, p.pid)) errors[`docs.${d}:${p.pid}`] = 'required';
  if (!has('walletProof')) errors['docs.walletProof'] = 'required';
  return errors;
}
