// v6.1 商户后台的交互逻辑。
// - 原型模式：使用 v6-mock.ts 的模拟数据，所有操作只改页面上的数据，不调用后端。
// - 正式模式：接口在开发阶段接入（/api/merchant/），数据格式和模拟数据一致。
import copy from '../i18n/merchant.json';
import { calcFee, describeFee, fmtUsdt, isTronAddress, parseUsdt, shortAddr } from '../lib/money';
import { manualMatch, matchOnCreate, stateOf, unmatch } from '../lib/matching';
import * as M from './v6-mock';
import { copyBtn, field, fieldErr, fmtTime, h, makeDialog, mono, qrDataUrl, stat, status, table, toast, tpl } from './ui';

const root = document.getElementById('m-root')!;
const lang = (root.dataset.lang || 'en') as 'en' | 'zh';
const base = root.dataset.base || '/';
const PROTO = root.dataset.prototype === '1';
const c = copy[lang];
const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
const say = (m: string) => toast(root, '[data-mtoast]', m);
const dialog = makeDialog(root, 'm');
const t = (iso: string) => (iso ? fmtTime(iso, lang) : '—');
const usd = (n: number) => fmtUsdt(n);
const CUST_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
const pct = (ppm: number) => String(ppm / 10000);

// ---------- 视图与导航 ----------
const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
const showView = (v: string) => views.forEach((x) => (x.hidden = x.dataset.view !== v));
const TABS = ['overview', 'customers', 'orders', 'transactions', 'withdraw', 'api', 'callbacks'];
const render: Record<string, (p: HTMLElement) => void> = {};
let current = 'overview';
function go(tab: string) {
  if (!TABS.includes(tab)) tab = 'overview';
  current = tab;
  root.querySelectorAll<HTMLElement>('[data-mpanel]').forEach((p) => (p.hidden = p.dataset.mpanel !== tab));
  root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => (b.dataset.mtab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  render[tab]($(`[data-mpanel="${tab}"]`));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  updateCounts();
}
const refresh = () => go(current);
root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => b.addEventListener('click', () => { go(b.dataset.mtab!); window.scrollTo({ top: 0 }); }));
const myWd = () => M.withdrawals.filter((w) => w.merchantId === M.me.id);
const myCustomers = () => M.customers.filter((x) => x.merchantId === M.me.id);
const myOrders = () => M.orders.filter((o) => o.merchantId === M.me.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
const myDeposits = () => M.deposits.filter((d) => d.merchantId === M.me.id).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
function updateCounts() { $('[data-mcount="withdraw"]').textContent = String(myWd().filter((w) => w.status === 'pending').length); }
const toolbar = (title: string, ...right: (HTMLElement | null)[]) => h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, title), h('div', { class: 'tool-actions' }, ...right));
const custLink = (id: string) => h('button', { type: 'button', class: 'link-copy', onclick: (e: Event) => { e.stopPropagation(); customerDetail(id); } }, id);

// ---------- 登录 / 首次设置 ----------
$('[data-login]').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('#ml-otp').value.trim();
  const ok = $<HTMLInputElement>('#ml-em').value.includes('@') && $<HTMLInputElement>('#ml-pw').value && /^\d{6}$/.test(code);
  const er = $('[data-login-err]');
  // 正式接口在开发阶段接入；在那之前，测试环境和生产不能登录，避免显示模拟数据
  if (!PROTO) { er.textContent = lang === 'zh' ? '商户后台开发中，暂时不能登录。' : 'The merchant dashboard is not available yet.'; er.hidden = false; return; }
  if (!ok) { er.textContent = c.login.err; er.hidden = false; return; }
  er.hidden = true; enter();
});
$('[data-setup]').addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = $<HTMLInputElement>('#ms-pw').value, pw2 = $<HTMLInputElement>('#ms-pw2').value;
  const er = $('[data-setup-err]');
  if (pw.length < 12 || pw !== pw2) { er.textContent = c.setup.errPw; er.hidden = false; return; }
  if (!/^\d{6}$/.test($<HTMLInputElement>('#ms-otp').value.trim())) { er.textContent = c.wd.errCode; er.hidden = false; return; }
  er.hidden = true; say(c.setup.done); showView('login');
});
$('[data-mlogout]').addEventListener('click', () => showView('login'));
function enter() {
  showView('app');
  $('[data-merchant-name]').textContent = M.me.name;
  // 订单模式关闭时隐藏"订单"标签
  const ordersTab = $('[data-mtab="orders"]'); ordersTab.hidden = !M.me.mode.enabled;
  go(location.hash.slice(1));
}

// ---------- 概览 ----------
render.overview = (p) => {
  const ds = myDeposits();
  const today = ds.filter((d) => d.credited && Date.now() - Date.parse(d.time) < 864e5);
  const unmatched = ds.filter((d) => d.credited && !d.orderId);
  const pendingWd = myWd().filter((w) => w.status === 'pending');
  const open = myOrders().filter((o) => o.status === 'pending' || o.status === 'partial');
  p.replaceChildren(
    toolbar(c.overview.title, M.me.mode.enabled ? h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.overview.newOrder) : null),
    h('div', { class: 'stats' },
      stat(c.overview.available, usd(M.me.available), 'USDT'),
      stat(c.overview.frozen, usd(M.me.frozen), tpl(c.overview.frozenSub, { n: pendingWd.length })),
      stat(c.overview.today, usd(today.reduce((s, d) => s + d.amount, 0)), tpl(c.overview.todaySub, { n: today.length, fee: usd(today.reduce((s, d) => s + d.fee, 0)) })),
      M.me.mode.enabled ? stat(c.overview.openOrders, String(open.length), c.overview.openOrdersSub) : null,
      M.me.mode.enabled ? stat(c.overview.unmatched, usd(unmatched.reduce((s, d) => s + d.amount, 0)), tpl(c.overview.unmatchedSub, { n: unmatched.length })) : null),
    h('p', { class: 'hint muted' }, c.overview.balanceNote),
    h('h2', { class: 'h-sm' }, c.overview.recent),
    depositTable(ds.slice(0, 6)),
  );
};
function depResult(d: M.Deposit): HTMLElement {
  if (d.result === 'confirming') return status('submitted', tpl(c.dep.result.confirming, { n: d.confirmations || 0 }));
  if (d.result === 'below_min') return status('expired', c.dep.result.below_min);
  return status('approved', c.dep.result.credited);
}
const depOrder = (d: M.Deposit) => (!d.credited ? '—' : d.orderId ? mono(d.orderId) : M.me.mode.enabled ? status('in_progress', c.dep.unmatched) : '—');
function depositTable(rows: M.Deposit[], full = false): HTMLElement {
  const cc = c.dep.cols;
  const cols = full ? [cc.time, cc.customer, cc.address, cc.txid, cc.amount, cc.fee, cc.credited, cc.match, cc.status] : [cc.time, cc.customer, cc.amount, cc.credited, cc.match, cc.status];
  return table(cols, rows.map((d) => {
    const credited = d.credited ? usd(d.amount - d.fee) : '—';
    return full
      ? [t(d.time), custLink(d.customer), mono(shortAddr(d.address), d.address), mono(d.txid.slice(0, 10) + '…', d.txid), usd(d.amount), d.fee ? usd(d.fee) : '—', credited, depOrder(d), depResult(d)]
      : [t(d.time), custLink(d.customer), usd(d.amount), credited, depOrder(d), depResult(d)];
  }), c.common.none);
}

// ---------- 客户 ----------
let custQuery = '';
render.customers = (p) => {
  const cc = c.customers;
  const search = h('input', { type: 'search', class: 'input-sm input-wide', placeholder: cc.search, value: custQuery }) as HTMLInputElement;
  search.addEventListener('input', () => { custQuery = search.value; drawList(); });
  const listBox = h('div');
  const drawList = () => {
    const qs = custQuery.trim().toLowerCase();
    const list = myCustomers().filter((x) => !qs || [x.id, x.name, x.email].some((v) => v.toLowerCase().includes(qs)));
    const k = cc.cols;
    listBox.replaceChildren(table([k.id, k.name, k.email, k.address, k.total, k.count, k.fees, k.last, k.unmatched], list.map((x) => {
      const s = M.customerStats(M.me.id, x.id);
      return [mono(x.id), x.name || '—', x.email || '—', mono(shortAddr(x.address), x.address), usd(s.total), String(s.count), usd(s.fees), t(s.last), s.unmatched ? h('b', {}, usd(s.unmatched)) : '0.00'];
    }), c.common.none, { onRow: (i) => customerDetail(list[i].id), rowAttrs: (i) => ({ 'data-customer': list[i].id }) }));
  };
  drawList();
  p.replaceChildren(toolbar(cc.title, search, h('button', { type: 'button', class: 'btn btn-primary', onclick: createCustomer }, cc.new)), h('p', { class: 'hint muted' }, cc.body), listBox);
};
function createCustomer() {
  const cc = c.customers.create;
  const id = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  const name = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  const email = h('input', { type: 'email', autocomplete: 'off' }) as HTMLInputElement;
  const remark = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  dialog(cc.title, h('div', { class: 'stack' }, field('mc-id', cc.id, id, cc.idHint), field('mc-name', cc.name, name), field('mc-email', cc.email, email), field('mc-remark', cc.remark, remark)), cc.submit, () => {
    const v = id.value.trim();
    if (fieldErr(id, !CUST_RE.test(v) ? c.orders.create.errCustomer : M.customerOf(M.me.id, v) ? cc.errDup : null)) return false;
    const x = M.ensureCustomer(M.me.id, v, name.value.trim(), email.value.trim()); x.remark = remark.value.trim();
    say(cc.created); refresh(); setTimeout(() => customerDetail(v), 0);
  });
}
function customerDetail(id: string) {
  const x = M.customerOf(M.me.id, id); if (!x) return;
  const cd = c.customers.detail;
  const name = h('input', { value: x.name }) as HTMLInputElement, email = h('input', { type: 'email', value: x.email }) as HTMLInputElement, remark = h('input', { value: x.remark }) as HTMLInputElement;
  const rangeSel = h('select', { class: 'input-sm' }, ...['1', '7', '30', '0'].map((k) => h('option', { value: k, selected: k === '30' }, cd.ranges[k as '1']))) as HTMLSelectElement;
  const statsBox = h('div'), tables = h('div', { class: 'stack' });
  const draw = () => {
    const days = Number(rangeSel.value);
    const since = days ? Date.now() - days * 864e5 : 0;
    const s = M.customerStats(M.me.id, id, since);
    const k = c.customers.cols;
    statsBox.replaceChildren(h('div', { class: 'stats' }, stat(k.total, usd(s.total), 'USDT'), stat(k.count, String(s.count)), stat(k.fees, usd(s.fees), 'USDT'), stat(k.unmatched, usd(s.unmatched), 'USDT')));
    const os = myOrders().filter((o) => o.customer === id && Date.parse(o.createdAt) >= since);
    const ds = myDeposits().filter((d) => d.customer === id && Date.parse(d.time) >= since);
    const ws = myWd().filter((w) => w.customer === id && Date.parse(w.time) >= since);
    const oc = c.orders.cols, wc = c.wd.cols;
    tables.replaceChildren(...([
      M.me.mode.enabled ? h('h3', { class: 'h-sm m0' }, cd.orders) : null,
      M.me.mode.enabled ? table([oc.id, oc.amount, oc.matched, oc.status, oc.created], os.map((o) => [mono(o.id), usd(o.amount), usd(o.matched), orderBadge(o.status), t(o.createdAt)]), c.common.none) : null,
      h('h3', { class: 'h-sm m0' }, cd.deposits),
      table([c.dep.cols.time, c.dep.cols.amount, c.dep.cols.credited, c.dep.cols.match, c.dep.cols.status], ds.map((d) => [t(d.time), usd(d.amount), d.credited ? usd(d.amount - d.fee) : '—', depOrder(d), depResult(d)]), c.common.none),
      h('h3', { class: 'h-sm m0' }, cd.payouts),
      table([wc.time, wc.id, wc.amount, wc.status], ws.map((w) => [t(w.time), mono(w.id), usd(w.amount), status(WD_CLS[w.status], c.wd.status[w.status])]), c.common.none),
    ].filter(Boolean) as Node[]));
  };
  rangeSel.addEventListener('change', draw);
  draw();
  const body = h('div', { class: 'stack' },
    h('dl', { class: 'kv' }, h('dt', {}, c.customers.cols.id), h('dd', {}, mono(x.id)),
      h('dt', {}, cd.address), h('dd', {}, h('span', { class: 'copy-row' }, mono(x.address), copyBtn(() => x.address, c.common.copy, c.common.copied, 'link-copy')))),
    h('div', { class: 'fgrid fgrid-3' }, field('mcd-name', c.customers.create.name, name), field('mcd-email', c.customers.create.email, email), field('mcd-remark', c.customers.create.remark, remark)),
    h('div', { class: 'row-actions' }, h('label', { class: 'inline-label' }, cd.range, rangeSel), h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => say(cd.exported) }, cd.statement)),
    statsBox, tables);
  dialog(x.name ? `${x.name} · ${x.id}` : x.id, body, cd.save, () => { x.name = name.value.trim(); x.email = email.value.trim(); x.remark = remark.value.trim(); say(cd.saved); refresh(); });
}

// ---------- 订单 ----------
const ORDER_CLS: Record<M.OrderState, string> = { pending: 'invited', partial: 'in_progress', completed: 'approved', overpaid: 'submitted', expired: 'expired', expired_partial: 'needs_info' };
const orderBadge = (s: M.OrderState) => status(ORDER_CLS[s], c.orders.status[s]);
let orderFilter = 'all', orderCust = '';
const payUrl = (o: M.Order) => {
  const u = `${location.origin}${base}pay/${o.id}/`;
  if (!PROTO) return u;
  // 原型：付款页面拿不到商户后台里新建的订单，用链接参数带过去
  const addr = M.customerOf(M.me.id, o.customer)?.address || '';
  return `${u}?a=${fmtUsdt(o.amount, 0).replace(/,/g, '')}&addr=${addr}&exp=${Date.parse(o.expiresAt)}&got=${o.matched}`;
};
const settingsNote = () => { const m = M.me.mode; return tpl(c.orders.settings, { low: pct(m.low), high: pct(m.high), ttl: m.ttlMin, lookback: m.lookbackH }); };
// 原型：订单到了过期时间，按规则更新状态（正式版由每分钟的任务处理）
const tickOrders = () => myOrders().forEach((o) => (o.status = stateOf(o)));
render.orders = (p) => {
  if (!M.me.mode.enabled) { p.replaceChildren(toolbar(c.orders.title), h('p', { class: 'note-box' }, c.orders.modeOff)); return; }
  tickOrders();
  const all = myOrders();
  const filters = h('div', { class: 'filters', role: 'group' }, ...['all', 'pending', 'partial', 'completed', 'overpaid', 'expired', 'expired_partial'].map((k) => {
    const n = k === 'all' ? all.length : all.filter((o) => o.status === k).length;
    return h('button', { type: 'button', 'aria-pressed': String(orderFilter === k), onclick: () => { orderFilter = k; render.orders(p); } }, `${k === 'all' ? c.common.all : c.orders.status[k as M.OrderState]} ${n}`);
  }));
  const cust = h('input', { type: 'search', class: 'input-sm', placeholder: c.orders.filterCustomer, value: orderCust }) as HTMLInputElement;
  cust.addEventListener('change', () => { orderCust = cust.value.trim(); render.orders(p); });
  const list = all.filter((o) => (orderFilter === 'all' || o.status === orderFilter) && (!orderCust || o.customer.includes(orderCust)));
  const oc = c.orders.cols;
  p.replaceChildren(
    toolbar(c.orders.title, cust, h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.orders.new)),
    h('p', { class: 'note-box', 'data-order-settings': '' }, settingsNote()),
    filters,
    table([oc.id, oc.merchantNo, oc.customer, oc.amount, oc.matched, oc.status, oc.created, oc.expires],
      list.map((o) => [mono(o.id), o.merchantNo, custLink(o.customer), usd(o.amount), o.matched ? usd(o.matched) : '—', orderBadge(o.status), t(o.createdAt), t(o.expiresAt)]),
      c.common.none, { onRow: (i) => orderDetail(list[i]), rowAttrs: (i) => ({ 'data-order': list[i].id }) }),
  );
};
function orderDetail(o: M.Order) {
  const cd = c.orders.detail;
  const cu = M.customerOf(M.me.id, o.customer)!;
  const url = payUrl(o);
  const box = h('div', { class: 'stack' });
  const draw = () => {
    o.status = stateOf(o);
    const matched = myDeposits().filter((d) => d.orderId === o.id);
    const free = myDeposits().filter((d) => d.customer === o.customer && d.credited && !d.orderId);
    const pctNow = o.amount ? Math.round((o.matched / o.amount) * 1000) / 10 : 0;
    const dc = c.dep.cols;
    box.replaceChildren(
      h('dl', { class: 'kv' },
        h('dt', {}, c.orders.cols.merchantNo), h('dd', {}, o.merchantNo),
        h('dt', {}, cd.customer), h('dd', {}, mono(o.customer), cu.name ? ` · ${cu.name}` : ''),
        h('dt', {}, c.orders.cols.amount), h('dd', {}, `${usd(o.amount)} USDT`),
        h('dt', {}, c.orders.cols.matched), h('dd', {}, tpl(cd.sum, { sum: usd(o.matched), amount: usd(o.amount), pct: pctNow })),
        h('dt', {}, c.orders.cols.status), h('dd', {}, orderBadge(o.status)),
        h('dt', {}, c.orders.cols.expires), h('dd', {}, t(o.expiresAt)),
        h('dt', {}, c.orders.detail.address), h('dd', {}, mono(cu.address))),
      h('p', { class: 'hint muted m0' }, tpl(cd.addressNote, { c: o.customer })),
      h('div', { class: 'f' }, h('span', { class: 'lbl' }, cd.payLink), h('div', { class: 'copy-row' }, mono(url.split('?')[0]), copyBtn(() => url, cd.copyLink, c.common.copied)), h('a', { class: 'link-copy', href: url, target: '_blank', rel: 'noopener', 'data-open-pay': '' }, cd.open + ' ↗')),
      h('h3', { class: 'h-sm m0' }, cd.matchedTitle),
      table([dc.time, dc.amount, cd.how, ''], matched.map((d) => [t(d.time), usd(d.amount), cd.types[d.matchType || 'deposit'],
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-unmatch': d.id, onclick: () => { unmatch(o, d); say(cd.done); draw(); } }, cd.unmatch)]), cd.none),
      h('h3', { class: 'h-sm m0' }, cd.unmatchedTitle),
      table([dc.time, dc.amount, ''], free.map((d) => [t(d.time), usd(d.amount),
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-match': d.id, onclick: () => { manualMatch(o, d); say(cd.done); draw(); } }, cd.match)]), cd.none),
    );
  };
  draw();
  dialog(tpl(cd.title, { id: o.id }), box, c.common.confirm, () => refresh());
}
function createOrder() {
  const cc = c.orders.create;
  const cust = h('input', { autocomplete: 'off', list: 'mo-cust-list' }) as HTMLInputElement;
  const dl = h('datalist', { id: 'mo-cust-list' }, ...myCustomers().map((x) => h('option', { value: x.id }, x.name)));
  const cname = h('input', { autocomplete: 'off' }) as HTMLInputElement, cemail = h('input', { type: 'email', autocomplete: 'off' }) as HTMLInputElement;
  const no = h('input', { autocomplete: 'off', value: `ACME-${88100 + M.orders.length + 413}` }) as HTMLInputElement;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  const body = h('div', { class: 'stack' }, field('mo-cust', cc.customer, cust, cc.customerHint), dl,
    h('div', { class: 'fgrid' }, field('mo-cname', `${cc.customerName} (${c.common.optional})`, cname), field('mo-cemail', `${cc.customerEmail} (${c.common.optional})`, cemail)),
    field('mo-no', cc.merchantNo, no, cc.merchantNoHint), field('mo-amt', cc.amount, amt), h('p', { class: 'hint muted m0' }, settingsNote()));
  dialog(cc.title, body, cc.submit, () => {
    const a = parseUsdt(amt.value);
    const cid = cust.value.trim();
    let bad = fieldErr(cust, CUST_RE.test(cid) ? null : cc.errCustomer);
    bad = fieldErr(no, !/^[A-Za-z0-9_-]{1,64}$/.test(no.value.trim()) ? cc.errMerchantNo : M.orders.some((o) => o.merchantNo === no.value.trim()) ? cc.errDup : null) || bad;
    bad = fieldErr(amt, !a ? cc.errAmount : null) || bad;
    if (bad) return false;
    M.ensureCustomer(M.me.id, cid, cname.value.trim(), cemail.value.trim());
    const m = M.me.mode;
    const now = Date.now();
    const o: M.Order = { merchantId: M.me.id, id: `ORD-20260929-${String(413 + M.orders.length).padStart(4, '0')}`, merchantNo: no.value.trim(), customer: cid, amount: a!, matched: 0, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + m.ttlMin * 60000).toISOString(), status: 'pending', low: m.low, high: m.high };
    M.orders.unshift(o);
    // 方向二：先到账、后建订单
    const hit = matchOnCreate(o, M.deposits.filter((d) => d.merchantId === M.me.id), m.lookbackH);
    if (hit.length) say(cc.matchedNow);
    orderFilter = 'all'; orderCust = '';
    go('orders');
    setTimeout(() => orderDetail(o), 0);
  });
}

// ---------- 交易 ----------
let txTab: 'deposits' | 'ledger' = 'deposits', onlyUnmatched = false, txCust = '';
render.transactions = (p) => {
  const ct = c.tx;
  const tabs = h('div', { class: 'filters', role: 'tablist' },
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'deposits'), onclick: () => { txTab = 'deposits'; render.transactions(p); } }, ct.tabDeposits),
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'ledger'), onclick: () => { txTab = 'ledger'; render.transactions(p); } }, ct.tabLedger));
  const cust = h('input', { type: 'search', class: 'input-sm', placeholder: c.orders.filterCustomer, value: txCust }) as HTMLInputElement;
  cust.addEventListener('change', () => { txCust = cust.value.trim(); render.transactions(p); });
  const um = h('input', { type: 'checkbox', checked: onlyUnmatched }) as HTMLInputElement;
  um.addEventListener('change', () => { onlyUnmatched = um.checked; render.transactions(p); });
  const lc = ct.ledgerCols;
  const deps = myDeposits().filter((d) => (!txCust || d.customer.includes(txCust)) && (!onlyUnmatched || (d.credited && !d.orderId)));
  const content = txTab === 'deposits' ? depositTable(deps, true) : h('div', { class: 'stack' }, h('p', { class: 'hint muted m0' }, ct.ledgerNote),
    table([lc.time, lc.type, c.dep.cols.customer, lc.amount, lc.balance, lc.ref], M.ledger.filter((l) => !txCust || (l.customer || '').includes(txCust)).map((l) => [t(l.time), ct.ledgerTypes[l.type], l.customer ? mono(l.customer) : '—', h('span', { class: l.amount < 0 ? 'neg' : 'pos' }, (l.amount > 0 ? '+' : '') + usd(l.amount)), usd(l.balance), mono(l.ref)]), c.common.none));
  p.replaceChildren(toolbar(ct.title, cust, txTab === 'deposits' && M.me.mode.enabled ? h('label', { class: 'inline-label' }, um, c.dep.filterUnmatched) : null, h('button', { type: 'button', class: 'btn btn-outline', onclick: () => say(c.common.exported) }, c.common.export)), tabs, content);
};

// ---------- 提币 ----------
const WD_CLS: Record<M.WdStatus, string> = { pending: 'submitted', rejected: 'rejected', cancelled: 'expired', signing: 'invited', broadcast: 'in_progress', completed: 'approved', failed: 'needs_info' };
render.withdraw = (p) => {
  const cw = c.wd;
  const kindPayout = h('input', { type: 'radio', name: 'wd-kind', value: 'payout', checked: true }) as HTMLInputElement;
  const kindCash = h('input', { type: 'radio', name: 'wd-kind', value: 'cashout' }) as HTMLInputElement;
  const to = h('input', { autocomplete: 'off', spellcheck: false, class: 'mono-input', placeholder: 'T…' }) as HTMLInputElement;
  const custIn = h('input', { autocomplete: 'off', list: 'mw-cust-list' }) as HTMLInputElement;
  const dl = h('datalist', { id: 'mw-cust-list' }, ...myCustomers().map((x) => h('option', { value: x.id }, x.name)));
  const wallets = M.me.cashoutWallets;
  const sel = h('select', {}, ...wallets.map((w) => h('option', { value: w }, w))) as HTMLSelectElement;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const toField = field('mw-to', cw.to, to);
  const custField = field('mw-cust', cw.customer, custIn, cw.customerHint);
  const selField = wallets.length ? field('mw-sel', cw.cashoutWallet, sel) : h('div', { class: 'f' }, h('span', { class: 'lbl' }, cw.cashoutWallet), h('p', { class: 'alert m0' }, cw.noWallet));
  selField.hidden = true;
  const fee = h('b'), freeze = h('b'), after = h('b');
  const summary = h('dl', { class: 'kv kv-tight' }, h('dt', {}, cw.fee), h('dd', {}, fee), h('dt', {}, cw.freeze), h('dd', {}, freeze), h('dt', {}, cw.after), h('dd', {}, after));
  const upd = () => {
    const a = parseUsdt(amt.value) || 0;
    const f = a ? calcFee(a, M.me.feeOut) : 0;
    const rule = describeFee(M.me.feeOut, lang);
    fee.textContent = !a ? rule : lang === 'en' ? `${usd(f)} USDT (${rule})` : `${usd(f)} USDT（${rule}）`;
    freeze.textContent = a ? `${usd(a + f)} USDT` : '—';
    after.textContent = `${usd(M.me.available - (a ? a + f : 0))} USDT`;
    after.classList.toggle('neg', a + f > M.me.available);
  };
  amt.addEventListener('input', upd);
  const onKind = () => { toField.hidden = kindCash.checked; custField.hidden = kindCash.checked; selField.hidden = !kindCash.checked; };
  kindPayout.addEventListener('change', onKind); kindCash.addEventListener('change', onKind);
  const form = h('form', { class: 'card form-card wd-form', novalidate: true },
    h('div', { class: 'f' }, h('span', { class: 'lbl' }, cw.kind), h('div', { class: 'choices' }, h('label', {}, kindPayout, cw.kindPayout), h('label', {}, kindCash, cw.kindCashout))),
    toField, custField, dl, selField, field('mw-amt', cw.amount, amt), summary, field('mw-code', cw.code, code),
    h('button', { class: 'btn btn-primary', type: 'submit' }, cw.submit));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cash = kindCash.checked;
    const a = parseUsdt(amt.value);
    const cid = custIn.value.trim();
    let bad = cash ? !wallets.length : fieldErr(to, isTronAddress(to.value) ? null : cw.errAddress);
    if (!cash) bad = fieldErr(custIn, !cid || CUST_RE.test(cid) ? null : c.orders.create.errCustomer) || bad;
    const f = a ? calcFee(a, M.me.feeOut) : 0;
    bad = fieldErr(amt, !a ? cw.errAmount : a + f > M.me.available ? cw.errInsufficient : null) || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : cw.errCode) || bad;
    if (bad) return;
    if (!cash && cid) M.ensureCustomer(M.me.id, cid);
    M.withdrawals.unshift({ id: `WD-${String(32 + M.withdrawals.length).padStart(4, '0')}`, merchant: M.me.name, merchantId: M.me.id, kind: cash ? 'cashout' : 'payout', customer: !cash && cid ? cid : undefined, to: cash ? sel.value : to.value.trim(), amount: a!, fee: f, source: 'web', status: 'pending', time: new Date().toISOString() });
    M.ledger.unshift({ time: new Date().toISOString(), type: 'freeze', amount: -(a! + f), balance: M.me.available - a! - f, ref: M.withdrawals[0].id, customer: cid || undefined });
    M.me.available -= a! + f; M.me.frozen += a! + f;
    say(tpl(cw.submitted, { amount: usd(a! + f) }));
    render.withdraw(p); updateCounts();
  });
  upd();
  const cc = cw.cols;
  p.replaceChildren(
    toolbar(cw.title),
    h('div', { class: 'note-box', 'data-sla': '' }, cw.note),
    h('div', { class: 'wd-grid' }, h('div', {}, h('h2', { class: 'h-sm' }, cw.new), form),
      h('div', { class: 'stats stats-col' }, stat(c.overview.available, usd(M.me.available), 'USDT'), stat(c.overview.frozen, usd(M.me.frozen), 'USDT'))),
    h('h2', { class: 'h-sm' }, cw.history),
    table([cc.time, cc.id, cc.kind, cc.customer, cc.to, cc.amount, cc.fee, cc.source, cc.status], myWd().map((w) => {
      const st = h('span', { class: 'status-cell' }, status(WD_CLS[w.status], cw.status[w.status]));
      if (w.status === 'pending') st.append(h('button', { type: 'button', class: 'link-btn', onclick: () => cancelWd(w, p) }, cw.cancel));
      if (w.reason) st.append(h('span', { class: 'hint muted' }, `${cw.reason}：${w.reason}`));
      return [t(w.time), mono(w.id), cw.kinds[w.kind], w.customer ? mono(w.customer) : '—', mono(shortAddr(w.to), w.to), usd(w.amount), usd(w.fee), cw.sources[w.source], st];
    }), c.common.none),
  );
};
function cancelWd(w: M.Withdrawal, p: HTMLElement) {
  dialog(c.wd.cancel, h('p', { class: 'm0' }, c.wd.cancelConfirm), c.wd.cancel, () => {
    w.status = 'cancelled';
    M.me.available += w.amount + w.fee; M.me.frozen -= w.amount + w.fee;
    M.ledger.unshift({ time: new Date().toISOString(), type: 'unfreeze', amount: w.amount + w.fee, balance: M.me.available, ref: w.id, customer: w.customer });
    say(tpl(c.wd.cancelled, { amount: usd(w.amount + w.fee) }));
    render.withdraw(p); updateCounts();
  }, true);
}

// ---------- API 设置 ----------
const api = { key: 'qc_live_7f3a9c21e84b', callback: 'https://api.acme-export.example/quickcome/callback', ips: [...M.me.ipWhitelist] };
const randSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
render.api = (p) => {
  const ca = c.api;
  const cb = h('input', { type: 'url', value: api.callback, class: 'mono-input' }) as HTMLInputElement;
  const ips = h('textarea', { rows: '4', class: 'mono-input', placeholder: '203.0.113.10' }) as HTMLTextAreaElement;
  ips.value = api.ips.join('\n');
  const warn = h('p', { class: 'alert m0', 'data-ip-warn': '' }, ca.ipWarn); warn.hidden = api.ips.length > 0;
  const cbForm = h('form', { class: 'stack', novalidate: true }, field('mapi-cb', ca.callbackUrl, cb, ca.callbackHint),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, c.common.save),
      h('button', { class: 'btn btn-outline', type: 'button', onclick: () => { M.callbacks.unshift({ id: 'evt_test' + Date.now().toString(36).slice(-4), time: new Date().toISOString(), event: 'deposit', ref: 'test', attempts: 1, result: 'ok', code: 200 }); say(ca.testSent); } }, ca.test)));
  cbForm.addEventListener('submit', (e) => { e.preventDefault(); if (fieldErr(cb, /^https:\/\/[^\s/]+\.[^\s]+$/.test(cb.value.trim()) ? null : ca.errCallback)) return; api.callback = cb.value.trim(); say(c.common.saved); });
  const ipForm = h('form', { class: 'stack', novalidate: true }, field('mapi-ip', ca.ipTitle, ips, ca.ipHint), warn, h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, c.common.save)));
  ipForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const lines = ips.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const badLine = lines.findIndex((x) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(x) && !/^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(x));
    if (fieldErr(ips, badLine >= 0 ? tpl(ca.errIp, { n: badLine + 1 }) : null)) return;
    api.ips = lines; M.me.ipWhitelist = lines; warn.hidden = lines.length > 0; say(c.common.saved);
  });
  const regen = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => {
    dialog(ca.regen, h('p', { class: 'm0' }, ca.regenConfirm), ca.regen, () => {
      const s = randSecret();
      setTimeout(() => dialog(ca.secret, h('div', { class: 'stack' }, h('p', { class: 'm0' }, ca.regenDone), h('div', { class: 'copy-row secret-box' }, mono(s), copyBtn(() => s, c.common.copy, c.common.copied))), c.common.confirm, null), 0);
    }, true);
  } }, ca.regen);
  p.replaceChildren(
    toolbar(ca.title, h('a', { class: 'btn btn-outline', href: `${base}docs/` }, ca.docs)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.keyTitle),
      h('dl', { class: 'kv' }, h('dt', {}, ca.key), h('dd', {}, h('span', { class: 'copy-row' }, mono(api.key), copyBtn(() => api.key, c.common.copy, c.common.copied, 'link-copy'))),
        h('dt', {}, ca.secret), h('dd', {}, h('span', { class: 'mono' }, '••••••••••••••••'), h('p', { class: 'hint muted m0' }, ca.secretHidden))), h('div', {}, regen)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.modeTitle),
      h('p', { class: 'm0' }, status(M.me.mode.enabled ? 'approved' : 'expired', M.me.mode.enabled ? ca.modeOn : ca.modeOffShort)),
      h('p', { class: 'hint muted m0' }, M.me.mode.enabled ? settingsNote() : c.orders.modeOff)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.callbackTitle), cbForm),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.ipTitle), ipForm),
  );
};

// ---------- 回调记录 ----------
render.callbacks = (p) => {
  const cc = c.cb;
  const RC: Record<string, string> = { ok: 'approved', retrying: 'submitted', failed: 'needs_info' };
  p.replaceChildren(
    toolbar(cc.title),
    table([cc.cols.time, cc.cols.id, cc.cols.event, cc.cols.ref, cc.cols.attempts, cc.cols.result, cc.cols.actions], M.callbacks.map((x) => {
      const res = h('span', { class: 'status-cell' }, status(RC[x.result], tpl(cc.results[x.result], { code: x.code ?? '—' })));
      if (x.next) res.append(h('span', { class: 'hint muted' }, tpl(cc.next, { t: t(x.next) })));
      return [t(x.time), mono(x.id), cc.events[x.event], mono(x.ref), String(x.attempts), res,
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { x.attempts += 1; x.result = 'ok'; x.code = 200; x.next = undefined; say(tpl(cc.resent, { id: x.id })); render.callbacks(p); } }, cc.resend)];
    }), c.common.none),
  );
};

// ---------- 启动 ----------
const params = new URLSearchParams(location.search);
if (params.has('setup')) { $<HTMLImageElement>('[data-setup-qr]').src = qrDataUrl('otpauth://totp/QuickCome:finance@acme-export.example?secret=JBSWY3DPEHPK3PXP&issuer=QuickCome'); showView('setup'); }
else showView('login');
