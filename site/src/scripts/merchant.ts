// v6 商户后台的交互逻辑。
// - 原型模式：使用 v6-mock.ts 的模拟数据，所有操作只改页面上的数据，不调用后端。
// - 正式模式：接口在开发阶段接入（/api/merchant/），数据格式和模拟数据一致。
import copy from '../i18n/merchant.json';
import { calcFee, describeFee, fmtUsdt, isTronAddress, parseUsdt, shortAddr } from '../lib/money';
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
const t = (iso: string) => fmtTime(iso, lang);

// ---------- 视图与导航 ----------
const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
const showView = (v: string) => views.forEach((x) => (x.hidden = x.dataset.view !== v));
const TABS = ['overview', 'orders', 'addresses', 'transactions', 'withdraw', 'api', 'callbacks'];
const render: Record<string, (p: HTMLElement) => void> = {};
function go(tab: string) {
  if (!TABS.includes(tab)) tab = 'overview';
  root.querySelectorAll<HTMLElement>('[data-mpanel]').forEach((p) => (p.hidden = p.dataset.mpanel !== tab));
  root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => (b.dataset.mtab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const p = $(`[data-mpanel="${tab}"]`);
  render[tab](p);
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  updateCounts();
}
root.querySelectorAll<HTMLElement>('[data-mtab]').forEach((b) => b.addEventListener('click', () => { go(b.dataset.mtab!); window.scrollTo({ top: 0 }); }));
function updateCounts() {
  const n = mine(M.withdrawals).filter((w) => w.status === 'pending').length;
  const b = $('[data-mcount="withdraw"]'); b.textContent = String(n);
}
const mine = <T extends { merchantId?: string; merchant?: string }>(xs: T[]) => xs.filter((x) => (x.merchantId ? x.merchantId === M.me.id : true));
const toolbar = (title: string, ...right: HTMLElement[]) => h('div', { class: 'toolbar' }, h('h1', { class: 'm0' }, title), right.length ? h('div', { class: 'tool-actions' }, ...right) : null);
const usd = (n: number) => fmtUsdt(n);

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
function enter() { showView('app'); $('[data-merchant-name]').textContent = M.me.name; go(location.hash.slice(1)); }

// ---------- 概览 ----------
render.overview = (p) => {
  const today = M.deposits.filter((d) => d.result === 'credited' && Date.now() - Date.parse(d.time) < 864e5);
  const pendingWd = mine(M.withdrawals).filter((w) => w.status === 'pending');
  const open = M.orders.filter((o) => o.status === 'pending');
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.overview.newOrder);
  p.replaceChildren(
    toolbar(c.overview.title, newBtn),
    h('div', { class: 'stats' },
      stat(c.overview.available, usd(M.me.available), 'USDT'),
      stat(c.overview.frozen, usd(M.me.frozen), tpl(c.overview.frozenSub, { n: pendingWd.length })),
      stat(c.overview.today, usd(today.reduce((s, d) => s + d.amount, 0)), tpl(c.overview.todaySub, { n: today.length, fee: usd(today.reduce((s, d) => s + d.fee, 0)) })),
      stat(c.overview.openOrders, String(open.length), c.overview.openOrdersSub)),
    h('p', { class: 'hint muted' }, c.overview.balanceNote),
    h('h2', { class: 'h-sm' }, c.overview.recent),
    depositTable(M.deposits.slice(0, 6)),
  );
};
function depResult(d: M.Deposit): HTMLElement {
  if (d.result === 'confirming') return status('submitted', tpl(c.dep.result.confirming, { n: d.confirmations || 0 }));
  if (d.result === 'below_min') return status('expired', c.dep.result.below_min);
  if (d.result === 'late') return status('needs_info', c.dep.result.late);
  if (d.orderStatus) return orderBadge(d.orderStatus);
  return status('approved', c.dep.result.credited);
}
function depositTable(rows: M.Deposit[], full = false): HTMLElement {
  const cc = c.dep.cols;
  const cols = full ? [cc.time, cc.type, cc.ref, cc.address, cc.txid, cc.amount, cc.fee, cc.credited, cc.status] : [cc.time, cc.type, cc.ref, cc.amount, cc.credited, cc.status];
  return table(cols, rows.map((d) => {
    const credited = d.result === 'credited' || d.result === 'late' ? usd(d.amount - d.fee) : '—';
    const base = [t(d.time), c.dep.types[d.kind], mono(d.ref)];
    return full
      ? [...base, mono(shortAddr(d.address), d.address), mono(d.txid.slice(0, 10) + '…', d.txid), usd(d.amount), d.fee ? usd(d.fee) : '—', credited, depResult(d)]
      : [...base, usd(d.amount), credited, depResult(d)];
  }), c.common.none);
}

// ---------- 订单 ----------
const ORDER_CLS: Record<M.OrderStatus, string> = { pending: 'invited', completed: 'approved', partial: 'needs_info', overpaid: 'submitted', expired: 'expired' };
const orderBadge = (s: M.OrderStatus) => status(ORDER_CLS[s], c.orders.status[s]);
let orderFilter = 'all';
const payUrl = (o: M.Order) => `${location.origin}${base}pay/${o.id}/` + (PROTO ? `?a=${fmtUsdt(o.amount, 0).replace(/,/g, '')}&ttl=${Math.round((Date.parse(o.expiresAt) - Date.now()) / 60000)}` : '');
render.orders = (p) => {
  const filters = h('div', { class: 'filters', role: 'group' }, ...['all', 'pending', 'completed', 'partial', 'overpaid', 'expired'].map((k) => {
    const n = k === 'all' ? M.orders.length : M.orders.filter((o) => o.status === k).length;
    return h('button', { type: 'button', 'aria-pressed': String(orderFilter === k), onclick: () => { orderFilter = k; render.orders(p); } }, `${k === 'all' ? c.common.all : c.orders.status[k as M.OrderStatus]} ${n}`);
  }));
  const list = M.orders.filter((o) => orderFilter === 'all' || o.status === orderFilter);
  const oc = c.orders.cols;
  p.replaceChildren(
    toolbar(c.orders.title, h('button', { type: 'button', class: 'btn btn-primary', onclick: createOrder }, c.orders.new)),
    h('p', { class: 'hint muted' }, c.orders.rule),
    filters,
    table([oc.id, oc.merchantNo, oc.amount, oc.received, oc.status, oc.created, oc.expires],
      list.map((o) => [mono(o.id), o.merchantNo, usd(o.amount), o.received ? usd(o.received) : '—', orderBadge(o.status), t(o.createdAt), t(o.expiresAt)]),
      c.common.none, { onRow: (i) => orderDetail(list[i]), rowAttrs: (i) => ({ 'data-order': list[i].id }) }),
  );
};
function orderDetail(o: M.Order) {
  const url = payUrl(o);
  const cd = c.orders.detail;
  const body = h('div', { class: 'stack' },
    h('dl', { class: 'kv' },
      h('dt', {}, c.orders.cols.merchantNo), h('dd', {}, o.merchantNo),
      h('dt', {}, c.orders.cols.amount), h('dd', {}, `${usd(o.amount)} USDT`),
      h('dt', {}, c.orders.cols.received), h('dd', {}, o.received ? `${usd(o.received)} USDT` : '—'),
      h('dt', {}, c.orders.cols.status), h('dd', {}, orderBadge(o.status)),
      h('dt', {}, c.orders.cols.expires), h('dd', {}, t(o.expiresAt)),
      h('dt', {}, cd.address), h('dd', {}, mono(o.address))),
    h('p', { class: 'hint muted m0' }, cd.addressNote),
    h('div', { class: 'f' }, h('span', { class: 'lbl' }, cd.payLink), h('div', { class: 'copy-row' }, mono(url.split('?')[0]), copyBtn(() => url, cd.copyLink, c.common.copied))),
    h('a', { class: 'btn btn-outline', href: url, target: '_blank', rel: 'noopener', 'data-open-pay': '' }, cd.open + ' ↗'),
  );
  dialog(tpl(cd.title, { id: o.id }), body, c.common.confirm, null, false, true);
}
function createOrder() {
  const cc = c.orders.create;
  const no = h('input', { autocomplete: 'off', value: `ACME-${88100 + M.orders.length + 413}` }) as HTMLInputElement;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  const ttl = h('input', { inputmode: 'numeric', value: '30' }) as HTMLInputElement;
  const body = h('div', { class: 'stack' }, field('mo-no', cc.merchantNo, no, cc.merchantNoHint), field('mo-amt', cc.amount, amt), field('mo-ttl', cc.ttl, ttl, cc.ttlHint));
  dialog(cc.title, body, cc.submit, () => {
    const a = parseUsdt(amt.value);
    const m = Number(ttl.value);
    let bad = fieldErr(no, !/^[A-Za-z0-9_-]{1,64}$/.test(no.value.trim()) ? cc.errMerchantNo : M.orders.some((o) => o.merchantNo === no.value.trim()) ? cc.errDup : null);
    bad = fieldErr(amt, !a ? cc.errAmount : null) || bad;
    bad = fieldErr(ttl, !(Number.isInteger(m) && m >= 5 && m <= 1440) ? cc.errTtl : null) || bad;
    if (bad) return false;
    const free = M.pool.find((x) => x.state === 'free');
    const address = free ? free.address : M.fakeAddr();
    if (free) { free.state = 'busy'; } else M.pool.unshift({ address, state: 'busy' });
    const o: M.Order = { id: `ORD-20260929-${String(413 + M.orders.length).padStart(4, '0')}`, merchantNo: no.value.trim(), amount: a!, received: 0, address, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + m * 60000).toISOString() };
    const pf = M.pool.find((x) => x.address === address); if (pf) pf.order = o.id;
    M.orders.unshift(o);
    orderFilter = 'all';
    go('orders');
    setTimeout(() => orderDetail(o), 0);
  });
}

// ---------- 地址 ----------
render.addresses = (p) => {
  const ca = c.addresses;
  const inp = h('input', { autocomplete: 'off', placeholder: 'user_12345' }) as HTMLInputElement;
  const form = h('form', { class: 'inline-form', novalidate: true },
    field('ma-uid', ca.useridInput, inp), h('button', { class: 'btn btn-primary', type: 'submit' }, ca.apply));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = inp.value.trim();
    if (fieldErr(inp, /^[A-Za-z0-9_-]{1,64}$/.test(v) ? null : ca.errUserid)) return;
    const ex = M.useridAddrs.find((x) => x.userid === v);
    if (ex) say(ca.existing); else { M.useridAddrs.unshift({ userid: v, address: M.fakeAddr(), received: 0, createdAt: new Date().toISOString() }); say(ca.created); }
    render.addresses(p);
  });
  const PS: Record<string, string> = { busy: 'invited', cooling: 'in_progress', free: 'approved' };
  p.replaceChildren(
    toolbar(ca.title),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.useridTitle), h('p', { class: 'hint muted m0' }, ca.useridBody), form,
      table([ca.useridCols.userid, ca.useridCols.address, ca.useridCols.received, ca.useridCols.created],
        M.useridAddrs.map((x) => [mono(x.userid), h('span', { class: 'copy-row' }, mono(x.address), copyBtn(() => x.address, c.common.copy, c.common.copied, 'link-copy')), usd(x.received), t(x.createdAt)]), c.common.none)),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.poolTitle), h('p', { class: 'hint muted m0' }, ca.poolBody),
      table([ca.poolCols.address, ca.poolCols.state, ca.poolCols.order, ca.poolCols.until],
        M.pool.map((x) => [mono(x.address), status(PS[x.state], ca.poolState[x.state]), x.order ? mono(x.order) : '—', x.until ? t(x.until) : '—']), c.common.none)),
  );
};

// ---------- 交易 ----------
let txTab: 'deposits' | 'ledger' = 'deposits';
render.transactions = (p) => {
  const ct = c.tx;
  const tabs = h('div', { class: 'filters', role: 'tablist' },
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'deposits'), onclick: () => { txTab = 'deposits'; render.transactions(p); } }, ct.tabDeposits),
    h('button', { type: 'button', 'aria-pressed': String(txTab === 'ledger'), onclick: () => { txTab = 'ledger'; render.transactions(p); } }, ct.tabLedger));
  const lc = ct.ledgerCols;
  const content = txTab === 'deposits' ? depositTable(M.deposits, true) : h('div', { class: 'stack' }, h('p', { class: 'hint muted m0' }, ct.ledgerNote),
    table([lc.time, lc.type, lc.amount, lc.balance, lc.ref], M.ledger.map((l) => [t(l.time), ct.ledgerTypes[l.type], h('span', { class: l.amount < 0 ? 'neg' : 'pos' }, (l.amount > 0 ? '+' : '') + usd(l.amount)), usd(l.balance), mono(l.ref)]), c.common.none));
  p.replaceChildren(toolbar(ct.title, h('button', { type: 'button', class: 'btn btn-outline', onclick: () => say(c.common.exported) }, c.common.export)), tabs, content);
};

// ---------- 提币 ----------
const WD_CLS: Record<M.WdStatus, string> = { pending: 'submitted', rejected: 'rejected', cancelled: 'expired', signing: 'invited', broadcast: 'in_progress', completed: 'approved', failed: 'needs_info' };
render.withdraw = (p) => {
  const cw = c.wd;
  const kindPayout = h('input', { type: 'radio', name: 'wd-kind', value: 'payout', checked: true }) as HTMLInputElement;
  const kindCash = h('input', { type: 'radio', name: 'wd-kind', value: 'cashout' }) as HTMLInputElement;
  const to = h('input', { autocomplete: 'off', spellcheck: false, class: 'mono-input', placeholder: 'T…' }) as HTMLInputElement;
  const wallets = M.me.cashoutWallets;
  const sel = h('select', {}, ...wallets.map((w) => h('option', { value: w }, w))) as HTMLSelectElement;
  const amt = h('input', { inputmode: 'decimal', autocomplete: 'off' }) as HTMLInputElement;
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) as HTMLInputElement;
  const toField = field('mw-to', cw.to, to);
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
  const onKind = () => { toField.hidden = kindCash.checked; selField.hidden = !kindCash.checked; };
  kindPayout.addEventListener('change', onKind); kindCash.addEventListener('change', onKind);
  const form = h('form', { class: 'card form-card wd-form', novalidate: true },
    h('div', { class: 'f' }, h('span', { class: 'lbl' }, cw.kind), h('div', { class: 'choices' }, h('label', {}, kindPayout, cw.kindPayout), h('label', {}, kindCash, cw.kindCashout))),
    toField, selField, field('mw-amt', cw.amount, amt), summary, field('mw-code', cw.code, code),
    h('button', { class: 'btn btn-primary', type: 'submit' }, cw.submit));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cash = kindCash.checked;
    const a = parseUsdt(amt.value);
    let bad = cash ? !wallets.length : fieldErr(to, isTronAddress(to.value) ? null : cw.errAddress);
    const f = a ? calcFee(a, M.me.feeOut) : 0;
    bad = fieldErr(amt, !a ? cw.errAmount : a + f > M.me.available ? cw.errInsufficient : null) || bad;
    bad = fieldErr(code, /^\d{6}$/.test(code.value.trim()) ? null : cw.errCode) || bad;
    if (bad) return;
    M.withdrawals.unshift({ id: `WD-${String(32 + M.withdrawals.length).padStart(4, '0')}`, merchant: M.me.name, merchantId: M.me.id, kind: cash ? 'cashout' : 'payout', to: cash ? sel.value : to.value.trim(), amount: a!, fee: f, source: 'web', status: 'pending', time: new Date().toISOString() });
    M.ledger.unshift({ time: new Date().toISOString(), type: 'freeze', amount: -(a! + f), balance: M.me.available - a! - f, ref: M.withdrawals[0].id });
    M.me.available -= a! + f; M.me.frozen += a! + f;
    say(tpl(cw.submitted, { amount: usd(a! + f) }));
    render.withdraw(p); updateCounts();
  });
  upd();
  const cc = cw.cols;
  const list = mine(M.withdrawals);
  p.replaceChildren(
    toolbar(cw.title),
    h('div', { class: 'note-box', 'data-sla': '' }, cw.note),
    h('div', { class: 'wd-grid' }, h('div', {}, h('h2', { class: 'h-sm' }, cw.new), form),
      h('div', { class: 'stats stats-col' }, stat(c.overview.available, usd(M.me.available), 'USDT'), stat(c.overview.frozen, usd(M.me.frozen), 'USDT'))),
    h('h2', { class: 'h-sm' }, cw.history),
    table([cc.time, cc.id, cc.kind, cc.to, cc.amount, cc.fee, cc.source, cc.status], list.map((w) => {
      const st = h('span', { class: 'status-cell' }, status(WD_CLS[w.status], cw.status[w.status]));
      if (w.status === 'pending') st.append(h('button', { type: 'button', class: 'link-btn', onclick: () => cancelWd(w, p) }, cw.cancel));
      if (w.reason) st.append(h('span', { class: 'hint muted' }, `${cw.reason}：${w.reason}`));
      return [t(w.time), mono(w.id), cw.kinds[w.kind], mono(shortAddr(w.to), w.to), usd(w.amount), usd(w.fee), cw.sources[w.source], st];
    }), c.common.none),
  );
};
function cancelWd(w: M.Withdrawal, p: HTMLElement) {
  dialog(c.wd.cancel, h('p', { class: 'm0' }, c.wd.cancelConfirm), c.wd.cancel, () => {
    w.status = 'cancelled';
    M.me.available += w.amount + w.fee; M.me.frozen -= w.amount + w.fee;
    M.ledger.unshift({ time: new Date().toISOString(), type: 'unfreeze', amount: w.amount + w.fee, balance: M.me.available, ref: w.id });
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
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.callbackTitle), cbForm),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.ipTitle), ipForm),
    h('section', { class: 'card stack' }, h('h2', { class: 'h-sm m0' }, ca.sandboxTitle), h('p', { class: 'm0 muted' }, ca.sandboxBody)),
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
