// v6 回调发送（架构方案 v6 §2.6）：签名、重试、只允许 https 且不能指向内网。
// 签名：hex( HMAC-SHA256( 商户的 API Secret, 时间戳 + "\n" + 原始请求体 ) )
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { money } from './common.js';

/** 第 1 次立即发送；失败后分别在 1 分钟、5 分钟、30 分钟、2 小时、6 小时、12 小时、24 小时后重试，然后停止 */
export const RETRY_MIN = [1, 5, 30, 120, 360, 720, 1440];

export const signCallback = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}\n${body}`).digest('hex');

const PRIVATE_V4 = [['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const v4num = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
export function isPrivateIp(ip) {
  if (isIP(ip) === 4) return PRIVATE_V4.some(([base, bits]) => (v4num(ip) >>> (32 - bits)) === (v4num(base) >>> (32 - bits)));
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}
/** 回调地址检查：https、没有账号密码、域名解析出来的地址都不是内网（防止借我们的服务器访问内网） */
export async function checkCallbackUrl(raw, resolve = (h) => lookup(h, { all: true })) {
  let u;
  try { u = new URL(raw); } catch { return 'invalid_url'; }
  if (u.protocol !== 'https:') return 'https_required';
  if (u.username || u.password) return 'invalid_url';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await resolve(host).catch(() => [])).map((x) => x.address);
  if (!ips.length) return 'unresolvable';
  if (ips.some(isPrivateIp)) return 'private_address';
  return null;
}

/**
 * 发送到期的回调。getSecret(merchantId) 返回 { url, secret }。
 * 每次最多发送 limit 条，并发 concurrency 条，每条最多等 timeoutMs。
 */
export async function deliverDue(db, { getTarget, fetchImpl = fetch, resolve, now = new Date(), limit = 50, concurrency = 10, timeoutMs = 5000 }) {
  const due = await db.query(`select * from callbacks where status = 'pending' and next_at <= $1 order by next_at limit $2`, [now, limit]);
  let ok = 0, failed = 0;
  const one = async (cb) => {
    const target = await getTarget(cb.merchant_id);
    let code = null, good = false;
    if (target?.url && target.secret && !(await checkCallbackUrl(target.url, resolve))) {
      // 金额和开放 API 的返回一样用字符串（例如 "500.00"）；数据库里存的是整数（0.000001 USDT）（BUG-P9）
      const body = JSON.stringify(money(cb.payload));
      const ts = String(Math.floor(now.getTime() / 1000));
      try {
        const res = await fetchImpl(target.url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body,
          headers: { 'content-type': 'application/json', 'user-agent': 'QuickCome-Callback/1', 'X-QC-Event-Id': cb.id, 'X-QC-Timestamp': ts, 'X-QC-Signature': signCallback(target.secret, ts, body) },
        });
        code = res.status; good = res.status >= 200 && res.status < 300;
      } catch { code = null; }
    }
    const attempts = cb.attempts + 1;
    if (good) { ok++; await db.query(`update callbacks set status = 'ok', attempts = $2, last_code = $3 where id = $1`, [cb.id, attempts, code]); return; }
    const delay = RETRY_MIN[attempts - 1];
    if (delay === undefined) { failed++; await db.query(`update callbacks set status = 'failed', attempts = $2, last_code = $3 where id = $1`, [cb.id, attempts, code]); return; }
    await db.query(`update callbacks set attempts = $2, last_code = $3, next_at = $4 where id = $1`, [cb.id, attempts, code, new Date(now.getTime() + delay * 60_000)]);
  };
  for (let i = 0; i < due.length; i += concurrency) await Promise.all(due.slice(i, i + concurrency).map(one));
  return { sent: due.length, ok, failed };
}

/** 手动重发：重新排到最前面，重试次数清零 */
export async function resend(db, merchantId, id) {
  const r = await db.query(`update callbacks set status = 'pending', attempts = 0, next_at = now() where id = $1 and ($2::text is null or merchant_id = $2) returning id`, [id, merchantId]);
  return r.length > 0;
}
