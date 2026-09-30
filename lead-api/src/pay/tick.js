// v6 每分钟任务 api/tick（架构方案 v6 §2.3）：由 cron-job.org 每分钟调用一次。
// 顺序：① 扫描已确认的 USDT 转账 → ② 订单过期 → ③ 提币的链上确认 → ④ 发送回调 → ⑤ 合并发送提币通知邮件 → 记录运行时间。
// cron-job.org 最多等 30 秒，所以整体控制在 25 秒内；没做完的下一分钟接着做。
import { recordDeposit, expireOrders, settleWithdrawal, getMeta, setMeta } from './core.js';
import { deliverDue } from './callbacks.js';
import { fmtUsdt } from './money.js';

const OVERLAP_MS = 60_000; // 每次往前多扫 1 分钟，防止边界上的事件漏掉（重复的由唯一约束去掉）
const MAX_WINDOW_MS = 10 * 60_000;

/** ① 扫链：从上次的时间点往后读，只处理转到我们客户地址的转账 */
export async function scan(db, tron, { now = Date.now(), budgetMs = 12_000, maxPages = 40 } = {}) {
  const started = Date.now();
  const cursor = (await getMeta(db, 'scan_cursor')) ?? now - 5 * 60_000; // 第一次运行：从 5 分钟前开始
  const minTs = Math.max(0, cursor - OVERLAP_MS);
  const maxTs = Math.min(now, cursor + MAX_WINDOW_MS);
  let fp = null, pages = 0, seen = 0, credited = 0, lastTs = cursor, complete = false;
  while (pages < maxPages && Date.now() - started < budgetMs) {
    const { events, next } = await tron.transfers({ minTs, maxTs, fingerprint: fp });
    pages++; seen += events.length;
    if (events.length) {
      const mine = new Set((await db.query('select address from customers where address = any($1::text[])', [[...new Set(events.map((e) => e.to))]])).map((r) => r.address));
      for (const e of events) {
        if (mine.has(e.to)) { const r = await recordDeposit(db, e); if (r.status === 'credited') credited++; }
        lastTs = Math.max(lastTs, e.time);
      }
    }
    if (!next || !events.length) { complete = true; break; }
    fp = next;
  }
  // 这一段全部读完：游标移到这一段的结尾；没读完：移到已经处理到的位置
  await setMeta(db, 'scan_cursor', complete ? maxTs : lastTs);
  return { pages, seen, credited, complete, cursor: complete ? maxTs : lastTs };
}

/** ③ 已广播的提币：链上确认成功就扣除冻结；失败就解冻并通知 Amos */
export async function confirmWithdrawals(db, tron, { notify } = {}) {
  const rows = await db.query(`select id, txid from withdrawals where status = 'broadcast' and txid is not null order by updated_at limit 50`);
  let done = 0;
  for (const w of rows) {
    const info = await tron.txInfo(w.txid).catch(() => null);
    if (!info) continue;
    await settleWithdrawal(db, w.id, info.ok);
    if (!info.ok && notify) await notify(`提币失败：${w.id}`, `提币 ${w.id} 的链上交易失败（${w.txid}），冻结的金额已退回商户余额。请到运营后台查看。`);
    done++;
  }
  return done;
}

/** ⑤ 新的提币申请合并成一封邮件（每分钟最多一封，需求 §5） */
export async function notifyWithdrawals(db, notify, adminUrl) {
  const rows = await db.query(`select w.id, w.amount, w.kind, w.source, m.name from withdrawals w join merchants m on m.id = w.merchant_id where w.status = 'pending' and not w.notified order by w.created_at`);
  if (!rows.length || !notify) return 0;
  const lines = rows.map((w) => `- ${w.id} · ${w.name} · ${w.kind === 'payout' ? '代付' : '商户提现'} · ${fmtUsdt(w.amount)} USDT · ${w.source === 'api' ? 'API' : '后台'}`);
  await notify(`有 ${rows.length} 笔新的提币申请待审核`, `${lines.join('\n')}\n\n请到运营后台审核：${adminUrl}\n商户看到的处理时效：东八区 8:00–23:00 内 1 小时处理。`);
  await db.query('update withdrawals set notified = true where id = any($1::text[])', [rows.map((w) => w.id)]);
  return rows.length;
}

export async function runTick({ db, tron, getTarget, notify, adminUrl = '', fetchImpl, resolve, confirmSweeps }) {
  const t0 = Date.now();
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.message }; console.error(`[tick] ${name}: ${e.message}`); } };
  await step('scan', () => scan(db, tron));
  await step('expired', () => expireOrders(db));
  await step('withdrawals', () => confirmWithdrawals(db, tron, { notify }));
  if (confirmSweeps) await step('sweeps', () => confirmSweeps());
  await step('callbacks', () => deliverDue(db, { getTarget, fetchImpl, resolve }));
  await step('mail', () => notifyWithdrawals(db, notify, adminUrl));
  out.ms = Date.now() - t0;
  await setMeta(db, 'tick_last', { at: new Date().toISOString(), ...out });
  return out;
}
