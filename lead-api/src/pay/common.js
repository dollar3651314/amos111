// v6 收付款接口的公共工具：密钥派生、金额格式、错误响应、查询。
import { hkdfSync } from 'node:crypto';
import { json } from '../kyb/http.js';
import { PayError } from './core.js';
import { fmtUsdt, parseUsdt } from './money.js';

/** 收付款用的密钥：和开户（KYB）一样由 APP_SECRET 派生，但用不同的用途标签，两边互不相通 */
export function derivePayKeys(appSecret) {
  if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET missing or too short (need 32+ chars)');
  const k = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.from('quickcome-pay-v1'), Buffer.from(info), 32));
  return { enc: k('enc'), session: k('session'), token: k('token') };
}

/** 对外的金额一律是字符串，例如 "100.50"（开发者文档） */
export const amt = (u) => (u === null || u === undefined ? null : fmtUsdt(u).replace(/,/g, ''));
const AMOUNT_KEYS = new Set(['amount', 'matched', 'fee', 'credited', 'available', 'frozen', 'total', 'fees', 'unmatched', 'balance', 'available_after', 'frozen_after', 'payouts']);
/** 把对象里的金额字段（整数）转成字符串 */
export function money(v) {
  if (Array.isArray(v)) return v.map(money);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, AMOUNT_KEYS.has(k) && typeof x === 'number' ? amt(x) : money(x)]));
  return v;
}
/** 请求里的金额：字符串或数字，最多 6 位小数 */
export function parseAmount(v, field = 'amount') {
  const u = typeof v === 'number' || typeof v === 'string' ? parseUsdt(String(v)) : null;
  if (!u) throw new PayError('invalid_param', 422, field);
  return u;
}

const MESSAGES = {
  invalid_signature: 'Missing or invalid signature', timestamp_expired: 'Timestamp is more than 5 minutes from server time', ip_not_allowed: 'Request IP is not whitelisted for withdrawals',
  merchant_disabled: 'Account disabled', not_found: 'Not found', invalid_param: 'Invalid or missing parameter', insufficient_balance: 'Amount + fee exceeds available balance',
  duplicate_merchant_order_no: 'merchant_order_no already used', idempotency_conflict: 'Idempotency-Key reused with a different request', order_mode_disabled: 'Order mode is not enabled for this account',
  idempotency_key_required: 'Idempotency-Key header is required', rate_limited: 'Too many requests', wallet_not_initialized: 'Service not ready', invalid_address: 'Invalid TRON address',
  address_not_registered: 'Address is not a registered cash-out wallet', invalid_state: 'Not allowed in the current state', request_in_progress: 'A request with this Idempotency-Key is still in progress', cannot_match: 'Deposit cannot be matched to this order', not_matched: 'Deposit is not matched to this order',
};
export function errorResponse(e) {
  if (e instanceof PayError) return json(e.status, { error: { code: e.code, message: MESSAGES[e.code] || e.code, ...(e.field ? { field: e.field } : {}) } });
  if (e?.status && e.message) return json(e.status, { error: { code: e.message, message: MESSAGES[e.message] || e.message } });
  console.error(`[pay] ${e?.stack || e}`);
  return json(500, { error: { code: 'internal_error', message: 'Internal error' } });
}

/** 翻页：按自增 id 倒序，cursor 是上一页最后一条的 id */
export function page(rows, limit) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? String(items[items.length - 1].cursor) : null };
}
export const limitOf = (q) => Math.min(100, Math.max(1, Number(q.get('limit')) || 50));
export const iso = (v) => (v ? new Date(v).toISOString() : null);
