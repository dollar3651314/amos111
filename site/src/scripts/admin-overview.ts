// 运营后台"概览"（登录后的首页）：资金、待处理、待归集、业务趋势、系统状态。
// 正式模式的数据来自 /api/wallet/?a=overview，原型模式用 admin-pay.ts 里的示例数据，页面由这里统一渲染。
// 金额都是字符串（例如 "1234.50"）；查不到链上余额时是 null，显示"—"。
import { fmtUsdt, parseUsdt } from '../lib/money';
import { h, stat, table } from './ui';

type Amt = string | null;
export interface OverviewData {
  funds: {
    collected_total: Amt; deposit_count: number; owed_total: Amt; owed_available: Amt; owed_frozen: Amt;
    assets_total: Amt; unswept_total: Amt; hot_usdt: Amt; cold_usdt: Amt; cold_configured: boolean;
    profit_total: Amt; profit_now: Amt; profit_after_sweep: Amt; income_fee_in: Amt; income_fee_out: Amt; income_dust: Amt;
  };
  todo: { withdrawals_count: number; withdrawals_amount: Amt; kyb_pending: number | null; merchants_to_open: number | null; anomalies: number; callbacks_failed: number };
  sweep: { unswept_total: Amt; address_count: number; over_threshold: number; over_threshold_total: Amt; threshold: Amt; hot_trx: Amt; energy_left: number | null; energy_per_sweep: number; month_sweep_trx: Amt };
  periods: Record<'today' | 'd7' | 'd30', { amount: Amt; count: number; fees_in: Amt; active_merchants: number; new_customers: number; orders_done: number; orders_closed: number }>;
  top_merchants: { name: string; amount: Amt; count: number }[];
  system: { tick_age_s: number | null; recon: { day: string; diff: Amt; complete: boolean } | null; db_bytes: number; db_limit_bytes: number };
}

const units = (v: Amt) => { if (v === null) return null; const neg = v.startsWith('-'); return (parseUsdt(neg ? v.slice(1) : v) ?? 0) * (neg ? -1 : 1); };
const usd = (v: Amt) => { const u = units(v); return u === null ? '—' : fmtUsdt(u); };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const ago = (s: number | null) => (s === null ? '从未运行' : s < 120 ? `${s} 秒前` : s < 7200 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`);

/** go(tab)：跳到对应的页面（例如 'p-withdrawals'） */
export function renderOverview(p: HTMLElement, d: OverviewData, go: (tab: string) => void, extra: HTMLElement | null = null) {
  const f = d.funds, t = d.todo, s = d.sweep, sys = d.system;
  const link = (label: string, tab: string, n: number, sub = '') => h('button', { type: 'button', class: `todo-item${n ? ' todo-on' : ''}`, onclick: () => go(tab) }, h('span', { class: 'todo-n' }, String(n)), h('span', {}, label, sub ? h('span', { class: 'muted' }, ` · ${sub}`) : null));
  const owedCovered = f.hot_usdt !== null && f.cold_usdt !== null ? (units(f.hot_usdt)! + units(f.cold_usdt)!) >= units(f.owed_total)! : null;
  const periodRow = (label: string, x: OverviewData['periods']['today']) => [label, `${usd(x.amount)} USDT`, String(x.count), `${usd(x.fees_in)} USDT`, String(x.active_merchants), String(x.new_customers), x.orders_closed ? `${pct(x.orders_done, x.orders_closed)}（${x.orders_done}/${x.orders_closed}）` : '—'];
  const dbPct = sys.db_limit_bytes ? Math.round((sys.db_bytes / sys.db_limit_bytes) * 100) : 0;
  p.replaceChildren(
    h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, '概览'), h('div', { class: 'tool-actions' }, extra)),
    h('p', { class: 'hint muted' }, '金额单位都是 USDT。热钱包和冷钱包的余额实时查询链上，客户地址里没归集的钱按账本计算。'),

    // ① 资金
    h('h2', { class: 'h-sm' }, '资金'),
    h('div', { class: 'stats' },
      stat('代收总额', usd(f.collected_total), `帮商户收到的钱 · ${f.deposit_count} 笔`),
      stat('欠商户', usd(f.owed_total), `可提 ${usd(f.owed_available)} · 提币中冻结 ${usd(f.owed_frozen)}`),
      stat('平台资产', usd(f.assets_total), `未归集 ${usd(f.unswept_total)} + 热钱包 ${usd(f.hot_usdt)}${f.cold_configured ? ` + 冷钱包 ${usd(f.cold_usdt)}` : ''}`),
      stat('利润', usd(f.profit_total), '平台资产 − 欠商户'),
    ),
    h('div', { class: 'stats' },
      stat('现在就能转走的利润', usd(f.profit_now), `热钱包${f.cold_configured ? ' + 冷钱包' : ''} − 欠商户。转走后，钱包里仍然够付所有商户的提币`),
      stat('归集后才能转走', usd(f.profit_after_sweep), '这部分还在客户地址里，归集到热钱包或冷钱包之后才能转走'),
      stat('利润来源合计', fmtUsdt((units(f.income_fee_in) ?? 0) + (units(f.income_fee_out) ?? 0) + (units(f.income_dust) ?? 0)), `收款手续费 ${usd(f.income_fee_in)} · 提币手续费 ${usd(f.income_fee_out)} · 低于 1 USDT 的转入 ${usd(f.income_dust)}`),
    ),
    owedCovered === false ? h('p', { class: 'alert' }, '热钱包和冷钱包的 USDT 少于欠商户的金额：商户提币时可能要先归集。不要从钱包里转走利润。') : h('span'),
    h('p', { class: 'hint muted' }, '利润来源三项加起来和"利润"之间的差，是还没对上的部分：例如你之前从钱包转走过利润，或者有到账还在确认中。以"对账"页面为准。'),

    // ② 待处理
    h('h2', { class: 'h-sm' }, '待处理'),
    h('div', { class: 'todo-grid' },
      link('笔提币待审核', 'p-withdrawals', t.withdrawals_count, t.withdrawals_count ? `${usd(t.withdrawals_amount)} USDT` : ''),
      t.kyb_pending === null ? null : link('份开户申请待审核', 'apps', t.kyb_pending),
      t.merchants_to_open === null ? null : link('个商户待开通收付款', 'p-merchants', t.merchants_to_open),
      link('条异常到账未处理', 'p-anomalies', t.anomalies),
      link('条回调 24 小时内发送失败', 'p-status', t.callbacks_failed),
    ),

    // ③ 待归集
    h('h2', { class: 'h-sm' }, '待归集'),
    h('div', { class: 'stats' },
      stat('未归集', usd(s.unswept_total), `${s.address_count} 个地址；其中 ${s.over_threshold} 个达到 ${usd(s.threshold)} USDT（合计 ${usd(s.over_threshold_total)}）`),
      stat('热钱包 TRX', usd(s.hot_trx), s.energy_left === null ? '能量查询失败' : `可借出能量 ${s.energy_left.toLocaleString('en')}，大约够 ${Math.floor(s.energy_left / s.energy_per_sweep)} 笔归集`),
      stat('本月归集花费', `${usd(s.month_sweep_trx)} TRX`, '补给新地址用于燃烧的 TRX（成本，不从 USDT 利润里扣）'),
    ),
    h('p', { class: 'm0' }, h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => go('p-sweep') }, '去归集')),

    // ④ 业务趋势
    h('h2', { class: 'h-sm' }, '业务'),
    table(['时间（东八区）', '收款金额', '笔数', '收款手续费', '有收款的商户', '新增客户', '订单按时完成'],
      [periodRow('今天', d.periods.today), periodRow('近 7 天', d.periods.d7), periodRow('近 30 天', d.periods.d30)], '—'),
    h('p', { class: 'hint muted' }, '订单按时完成 = 期间创建、已经结束的订单里，完成（含超额付款）的比例。'),
    h('h3', { class: 'h-sm' }, '近 30 天收款最多的商户'),
    table(['商户', '收款金额', '笔数'], d.top_merchants.map((m) => [m.name, `${usd(m.amount)} USDT`, String(m.count)]), '近 30 天还没有收款'),

    // ⑤ 系统状态
    h('h2', { class: 'h-sm' }, '系统'),
    h('div', { class: 'stats' },
      stat('链上监控', ago(sys.tick_age_s), sys.tick_age_s !== null && sys.tick_age_s <= 300 ? '正常（每分钟运行）' : '超过 5 分钟没有运行，请检查 cron-job.org'),
      stat('最近一次对账', sys.recon ? sys.recon.day : '还没有', sys.recon ? (!sys.recon.complete ? '没有查完所有地址' : units(sys.recon.diff) ? `差额 ${usd(sys.recon.diff)} USDT` : '一致') : '在"对账"页面点"立即对账"'),
      stat('数据库用量', `${dbPct}%`, `${(sys.db_bytes / 1048576).toFixed(1)} MB / 500 MB（免费额度）`),
    ),
  );
}
