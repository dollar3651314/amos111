// v6 运营后台的收付款接口：/api/wallet/?a=<动作>（页面 /admin/ 的"收付款"部分）。
// 只有 Amos 能用：沿用开户后台的登录（密码 + 验证器）；签名前还要再输入一次验证码。
// 签名流程（架构方案 v6 §2.4、§2.5）：
//   ① 服务器构造待签名的交易（withdraw-plan / sweep-plan）→ 返回交易原文
//   ② 浏览器自己解码、核对（verify.js），Amos 输入验证码（sign-verify）
//   ③ 浏览器用私钥签名，只把签名交回来（sign-submit）→ 服务器核对签名人后按顺序广播
import { json, readJson } from '../kyb/http.js';
import * as core from './core.js';
import { PayError, getMeta, setMeta, audit } from './core.js';
import { money, errorResponse, iso } from './common.js';
import { txIdOf, setExpiration, encodeSigned } from './txcodec.js';
import { signerOf } from './signing.js';
import { checkXpub, deriveAddress, isValidAddress } from './tron.js';
import { inviteMerchantUser } from './merchant-api.js';

const TRX = 1_000_000;
const SIGN_TTL_MS = 30 * 60 * 1000; // 待签名交易的有效期
const VERIFY_TTL_MS = 5 * 60 * 1000; // 验证码通过后 5 分钟内必须提交签名
const ENERGY_PER_SWEEP = 65_000; // 转 USDT 到已经有 USDT 的地址，大约需要的能量
const USDT_FEE_LIMIT = 30 * TRX;

export function createWalletApi({ db, tron, keys, wallets, requireAdmin, verifyAdminCode, send, origin = '', listApproved = async () => [], notify, runDaily = null, now = () => Date.now() }) {
  const hot = wallets.hot, cold = wallets.cold;
  const need = (cond, code, status = 422, field) => { if (!cond) throw new PayError(code, status, field); };
  const merchantRow = async (id) => { const m = await core.getMerchant(db, id); need(m, 'not_found', 404); return m; };
  const withExpiry = (tx) => { const rawHex = setExpiration(tx.raw_data_hex, now() + SIGN_TTL_MS); return { rawHex, txID: txIdOf(rawHex) }; };

  // ---------- 签名批次 ----------
  async function saveBatch(kind, plan) {
    const id = core.newId.batch();
    await db.query('insert into sign_batches (id, kind, status, plan) values ($1, $2, $3, $4::jsonb)', [id, kind, 'planned', JSON.stringify(plan)]);
    return id;
  }
  async function loadBatch(id, statuses) {
    const [b] = await db.query('select * from sign_batches where id = $1', [String(id || '')]);
    need(b, 'not_found', 404);
    need(statuses.includes(b.status), 'invalid_state', 409);
    return b;
  }
  /** 广播一组已签名的步骤；返回失败的原因（没有失败返回 null） */
  async function broadcastSteps(steps) {
    for (const s of steps) {
      try { s.txid = await tron.broadcastHex(encodeSigned(s.rawHex, s.signature)); s.status = 'broadcast'; }
      catch (e) { s.status = 'failed'; s.error = e.message; return e.message; }
    }
    return null;
  }

  const actions = {
    // ---------- 系统状态 ----------
    async status() {
      const tick = await getMeta(db, 'tick_last');
      const [cb] = await db.query(`select count(*) filter (where status = 'pending' and attempts = 0)::int waiting, count(*) filter (where status = 'pending' and attempts > 0)::int retrying,
        count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int failed from callbacks`);
      const [size] = await db.query('select pg_database_size(current_database())::bigint bytes').catch(() => [{ bytes: 0 }]);
      let solid = null; try { solid = await tron.solidBlock(); } catch { /* TronGrid 暂时不通 */ }
      return { tick, cursor: await getMeta(db, 'scan_cursor'), solid_block: solid, callbacks: cb, db_bytes: size.bytes, db_limit_bytes: 500 * 1024 * 1024, network: tron.network, initialized: !!(await getMeta(db, 'xpub')) };
    },

    // ---------- 商户 ----------
    async merchants() {
      const rows = await db.query(`select m.*, b.available, b.frozen, (select count(*)::int from customers c where c.merchant_id = m.id) customers from merchants m join balances b on b.merchant_id = m.id order by m.created_at`);
      const users = await db.query('select merchant_id, email, setup_hash is null active from merchant_users');
      const approved = await listApproved();
      const opened = new Set(rows.map((r) => r.kyb_ref).filter(Boolean));
      return {
        merchants: rows.map((m) => ({ id: m.id, name: m.name, kyb_ref: m.kyb_ref, status: m.status, fee_in: m.fee_in, fee_out: m.fee_out, order_mode: m.order_mode, available: m.available, frozen: m.frozen, customers: m.customers, ip_whitelist: m.ip_whitelist, cashout_wallets: m.cashout_wallets, users: users.filter((u) => u.merchant_id === m.id) })),
        pending: approved.filter((a) => !opened.has(a.ref)),
      };
    },
    /** 开通商户：用开户申请的企业名称和授权联系人邮箱，发送设置密码的邮件（AC-P1） */
    async 'merchant-open'(b, actor) {
      need(b.name && b.email && /@/.test(b.email), 'invalid_param', 422, 'email');
      for (const w of b.cashout_wallets || []) need(isValidAddress(w), 'invalid_address', 422, 'cashout_wallets');
      const m = await core.createMerchant(db, { name: String(b.name).slice(0, 200), kybRef: b.kyb_ref || null, feeIn: b.fee_in, feeOut: b.fee_out, mode: b.order_mode, cashoutWallets: b.cashout_wallets || [] });
      const lang = b.lang === 'en' ? 'en' : 'zh';
      await inviteMerchantUser(db, keys, { merchantId: m.id, email: String(b.email).trim(), send, origin, lang });
      await audit(db, actor, 'merchant.open', m.id, { name: m.name, email: b.email });
      return { id: m.id };
    },
    async 'merchant-save'(b, actor) {
      const m = await merchantRow(b.id);
      const fee_in = core.checkFee(b.fee_in ?? m.fee_in, 'fee_in'), fee_out = core.checkFee(b.fee_out ?? m.fee_out, 'fee_out'), mode = core.checkMode(b.order_mode ?? m.order_mode);
      const status = b.status === 'disabled' ? 'disabled' : 'active';
      const wallets = b.cashout_wallets ?? m.cashout_wallets;
      for (const w of wallets) need(isValidAddress(w), 'invalid_address', 422, 'cashout_wallets');
      await db.query('update merchants set fee_in = $2::jsonb, fee_out = $3::jsonb, order_mode = $4::jsonb, status = $5, cashout_wallets = $6::jsonb where id = $1',
        [m.id, JSON.stringify(fee_in), JSON.stringify(fee_out), JSON.stringify(mode), status, JSON.stringify(wallets)]);
      await audit(db, actor, 'merchant.save', m.id, { fee_in, fee_out, order_mode: mode, status, cashout_wallets: wallets });
      return { ok: true };
    },
    async 'merchant-reinvite'(b, actor) {
      const m = await merchantRow(b.id);
      await inviteMerchantUser(db, keys, { merchantId: m.id, email: String(b.email || '').trim(), send, origin, lang: b.lang === 'en' ? 'en' : 'zh' });
      await audit(db, actor, 'merchant.reinvite', m.id, { email: b.email });
      return { ok: true };
    },

    // ---------- 客户（跨商户） ----------
    async customers(b, actor, q) {
      const s = q.get('q') || '', mid = q.get('merchant_id') || '';
      const rows = await db.query(`select c.*, m.name merchant from customers c join merchants m on m.id = c.merchant_id
        where ($1 = '' or c.merchant_id = $1) and ($2 = '' or c.customer_id ilike '%' || $2 || '%' or c.name ilike '%' || $2 || '%' or c.address = $2)
        order by c.created_at desc limit 200`, [mid, s]);
      return { items: rows.map((c) => ({ merchant_id: c.merchant_id, merchant: c.merchant, customer_id: c.customer_id, name: c.name, address: c.address, total: c.total, count: c.count, fees: c.fees, unmatched: c.unmatched, onchain: c.onchain, last_payment_at: iso(c.last_at), created_at: iso(c.created_at) })) };
    },
    async customer(b, actor, q) {
      const mid = q.get('merchant_id') || '', cid = q.get('customer_id') || '';
      const [c] = await db.query('select * from customers where merchant_id = $1 and customer_id = $2', [mid, cid]);
      need(c, 'not_found', 404);
      const orders = await db.query('select id, amount, matched, status, created_at from orders where merchant_id = $1 and customer_id = $2 order by created_at desc limit 100', [mid, cid]);
      const deps = await db.query('select id, amount, fee, result, order_id, time, txid from deposits where merchant_id = $1 and customer_id = $2 order by time desc limit 100', [mid, cid]);
      return { customer: { merchant_id: mid, customer_id: cid, name: c.name, address: c.address, total: c.total, count: c.count, fees: c.fees, unmatched: c.unmatched, created_at: iso(c.created_at) },
        orders: orders.map((o) => ({ order_no: o.id, amount: o.amount, matched: o.matched, status: o.status, created_at: iso(o.created_at) })),
        deposits: deps.map((d) => ({ id: String(d.id), amount: d.amount, fee: d.fee, result: d.result, order_no: d.order_id, time: iso(d.time), txid: d.txid })) };
    },

    // ---------- 提币审核 ----------
    async withdrawals(b, actor, q) {
      const all = q.get('all') === '1';
      const rows = await db.query(`select w.*, m.name merchant from withdrawals w join merchants m on m.id = w.merchant_id ${all ? '' : "where w.status = 'pending'"} order by w.created_at desc limit 200`);
      let hotUsdt = null; try { hotUsdt = (await tron.account(hot)).trc20[tron.contract] || 0; } catch { /* 查询失败时页面显示"—" */ }
      return { hot: { address: hot, usdt: hotUsdt }, items: rows.map((w) => ({ id: w.id, merchant_id: w.merchant_id, merchant: w.merchant, kind: w.kind, customer_id: w.customer_id, to: w.to_address, amount: w.amount, fee: w.fee, source: w.source, status: w.status, txid: w.txid, reason: w.reason, created_at: iso(w.created_at), registered: w.kind === 'cashout' })) };
    },
    'withdraw-reject': (b, actor) => core.rejectWithdrawal(db, String(b.id || ''), b.reason, actor),
    /** 为选中的提币构造待签名的交易（热钱包 → 收款地址） */
    async 'withdraw-plan'(b) {
      const ids = [...new Set((b.ids || []).map(String))];
      need(ids.length > 0 && ids.length <= 50, 'invalid_param', 422, 'ids');
      const rows = await db.query(`select * from withdrawals where id = any($1::text[]) and status = 'pending'`, [ids]);
      need(rows.length === ids.length, 'invalid_state', 409);
      const hotUsdt = (await tron.account(hot)).trc20[tron.contract] || 0;
      const total = rows.reduce((s, w) => s + w.amount, 0);
      need(total <= hotUsdt, 'hot_wallet_insufficient', 409);
      const steps = [];
      for (const w of rows) {
        const tx = await tron.buildUsdtTransfer({ from: hot, to: w.to_address, amount: w.amount, feeLimit: USDT_FEE_LIMIT });
        steps.push({ kind: 'withdraw', stage: 1, withdrawal_id: w.id, owner: hot, expect: { to: w.to_address, amount: w.amount }, ...withExpiry(tx) });
      }
      const id = await saveBatch('withdraw', { steps });
      return { batch_id: id, steps: steps.map(({ kind, stage, withdrawal_id, rawHex, txID, expect }) => ({ kind, stage, withdrawal_id, rawHex, txID, expect })), total };
    },

    // ---------- 归集 ----------
    async 'sweep-list'() {
      const rows = await db.query(`select c.merchant_id, m.name merchant, c.customer_id, c.address, c.hd_index, c.onchain, c.activated, c.last_at
        from customers c join merchants m on m.id = c.merchant_id where c.onchain > 0 order by c.onchain desc limit 500`);
      const r = await tron.resources(hot).catch(() => null);
      const energyLeft = r ? Math.max(0, r.energyLimit - r.energyUsed) : null;
      return { hot, cold, energy_left: energyLeft, energy_per_sweep: ENERGY_PER_SWEEP, items: rows.map((x) => ({ merchant_id: x.merchant_id, merchant: x.merchant, customer_id: x.customer_id, address: x.address, index: x.hd_index, balance: x.onchain, activated: x.activated, last_payment_at: iso(x.last_at) })) };
    },
    /**
     * 为选中的地址构造归集交易。每个地址：
     *   第 1 步（热钱包签名）：已激活且能量够 → 借出能量；否则转一笔 TRX（顺便激活新地址）用来燃烧
     *   第 2 步（这个地址的私钥签名，由助记词推导）：把链上实际的 USDT 余额全部转到热钱包或冷钱包
     *   第 3 步（热钱包签名）：收回借出的能量
     */
    async 'sweep-plan'(b) {
      const dest = b.to === 'cold' ? cold : hot;
      need(dest, 'cold_wallet_not_configured', 409);
      const addrs = [...new Set((b.addresses || []).map(String))];
      need(addrs.length > 0 && addrs.length <= 30, 'invalid_param', 422, 'addresses');
      const rows = await db.query('select * from customers where address = any($1::text[])', [addrs]);
      need(rows.length === addrs.length, 'not_found', 404);
      const res = await tron.resources(hot);
      const energyPerTrx = res.totalEnergyWeight ? res.totalEnergyLimit / res.totalEnergyWeight : 0;
      let delegatable = await tron.canDelegate(hot).catch(() => 0);
      const params = Object.fromEntries((await tron.chainParams()).map((p) => [p.key, p.value]));
      const energyFee = params.getEnergyFee || 210; // 每单位能量燃烧多少 sun
      const burnSun = Math.ceil((ENERGY_PER_SWEEP * energyFee * 1.3 + 0.6 * TRX) / TRX) * TRX; // 燃烧能量 + 带宽，留 30% 余量
      const items = [];
      for (const c of rows) {
        const acc = await tron.account(c.address);
        const usdt = acc.trc20[tron.contract] || 0;
        if (!usdt) continue;
        const delegateSun = energyPerTrx ? Math.max(TRX, Math.ceil((ENERGY_PER_SWEEP * 1.1) / energyPerTrx) * TRX) : Infinity;
        const useEnergy = acc.activated && delegatable >= delegateSun;
        const steps = [];
        if (useEnergy) {
          delegatable -= delegateSun;
          steps.push({ kind: 'delegate', stage: 1, owner: hot, amount: delegateSun, ...withExpiry(await tron.buildDelegate({ from: hot, to: c.address, amount: delegateSun })) });
        } else {
          steps.push({ kind: 'fee_trx', stage: 1, owner: hot, amount: burnSun, ...withExpiry(await tron.buildTrxTransfer({ from: hot, to: c.address, amount: burnSun })) });
        }
        steps.push({ kind: 'sweep_usdt', stage: 2, owner: c.address, amount: usdt, ...withExpiry(await tron.buildUsdtTransfer({ from: c.address, to: dest, amount: usdt, feeLimit: USDT_FEE_LIMIT })) });
        if (useEnergy) steps.push({ kind: 'undelegate', stage: 3, owner: hot, amount: delegateSun, ...withExpiry(await tron.buildDelegate({ from: hot, to: c.address, amount: delegateSun, undelegate: true })) });
        items.push({ address: c.address, index: c.hd_index, merchant_id: c.merchant_id, customer_id: c.customer_id, amount: usdt, activated: acc.activated, use_energy: useEnergy, steps });
      }
      need(items.length > 0, 'nothing_to_sweep', 409);
      const id = await saveBatch('sweep', { to: b.to === 'cold' ? 'cold' : 'hot', dest, items });
      for (const it of items) await db.query(`insert into sweeps (batch_id, address, amount, status) values ($1, $2, $3, 'planned')`, [id, it.address, it.amount])
        .catch(() => { throw new PayError('sweep_in_progress', 409); });
      return { batch_id: id, to: b.to === 'cold' ? 'cold' : 'hot', burn_trx: burnSun, items: items.map((it) => ({ ...it, steps: it.steps.map(({ kind, stage, rawHex, txID, amount }) => ({ kind, stage, rawHex, txID, amount })) })) };
    },

    // ---------- 签名 ----------
    /** 签名前再验证一次验证码（需求 §7） */
    async 'sign-verify'(b) {
      const batch = await loadBatch(b.batch_id, ['planned']);
      need(await verifyAdminCode(String(b.code || '')), 'bad_code', 400);
      await db.query('update sign_batches set verified_until = $2 where id = $1', [batch.id, new Date(now() + VERIFY_TTL_MS)]);
      return { ok: true, verified_until: iso(now() + VERIFY_TTL_MS) };
    },
    /** 收到签名：逐笔核对"签名人 = 这笔交易的付款地址"，然后按顺序广播 */
    async 'sign-submit'(b, actor) {
      const batch = await loadBatch(b.batch_id, ['planned']);
      need(batch.verified_until && new Date(batch.verified_until).getTime() > now(), 'verify_required', 409);
      const sigs = b.signatures || {};
      const plan = batch.plan;
      const all = batch.kind === 'withdraw' ? plan.steps : plan.items.flatMap((it) => it.steps);
      for (const s of all) {
        const sig = String(sigs[s.txID] || '');
        need(txIdOf(s.rawHex) === s.txID, 'plan_corrupted', 500);
        need(signerOf(s.txID, sig) === s.owner, 'bad_signature', 422, s.txID);
        s.signature = sig;
      }
      await audit(db, actor, `${batch.kind}.signed`, batch.id, { count: all.length });
      if (batch.kind === 'withdraw') {
        for (const s of plan.steps) await core.markWithdrawal(db, s.withdrawal_id, 'signing', { batchId: batch.id });
        for (const s of plan.steps) {
          const err = await broadcastSteps([s]);
          if (err) { await core.settleWithdrawal(db, s.withdrawal_id, false); if (notify) await notify(`提币广播失败：${s.withdrawal_id}`, `原因：${err}。冻结的金额已退回商户。`); }
          else await core.markWithdrawal(db, s.withdrawal_id, 'broadcast', { txid: s.txid });
        }
        await db.query(`update sign_batches set status = 'done', plan = $2::jsonb, updated_at = now() where id = $1`, [batch.id, JSON.stringify(plan)]);
        return { ok: true, results: plan.steps.map((s) => ({ withdrawal_id: s.withdrawal_id, status: s.status, txid: s.txid || null, error: s.error || null })) };
      }
      // 归集：先广播第 1 步，后面的步骤由每分钟的任务在上一步确认后继续（sweepProgress）
      for (const it of plan.items) { const err = await broadcastSteps(it.steps.filter((s) => s.stage === 1)); if (err) it.error = err; }
      await db.query(`update sign_batches set status = 'stage1', plan = $2::jsonb, updated_at = now() where id = $1`, [batch.id, JSON.stringify(plan)]);
      await db.query(`update sweeps set status = 'broadcasting' where batch_id = $1`, [batch.id]);
      return { ok: true, status: 'stage1', items: plan.items.map((it) => ({ address: it.address, error: it.error || null })) };
    },
    async batches() {
      const rows = await db.query(`select id, kind, status, created_at, updated_at, plan from sign_batches order by created_at desc limit 30`);
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
        items: r.kind === 'sweep' ? r.plan.items.map((it) => ({ address: it.address, amount: it.amount, error: it.error || null, steps: it.steps.map((s) => ({ kind: s.kind, status: s.status || 'planned', txid: s.txid || null })) })) : undefined })) };
    },

    // ---------- 异常到账、对账 ----------
    async anomalies() {
      const rows = await db.query(`select a.*, m.name merchant from anomalies a left join merchants m on m.id = a.merchant_id order by a.created_at desc limit 200`);
      return { items: rows.map((a) => ({ id: String(a.id), type: a.type, merchant: a.merchant, customer_id: a.customer_id, address: a.address, amount: a.amount, ref: a.ref, handled: a.handled, created_at: iso(a.created_at) })) };
    },
    async 'anomaly-handle'(b, actor) { await db.query('update anomalies set handled = true where id = $1', [Number(b.id)]); await audit(db, actor, 'anomaly.handled', String(b.id)); return { ok: true }; },
    /** 立即运行每日任务（对账、其他代币检查、提醒）：测试环境没有 Vercel 的定时任务，生产也可以手动补跑 */
    async 'recon-run'(b, actor) {
      need(runDaily, 'not_configured', 503);
      await runDaily();
      await audit(db, actor, 'recon.run', '');
      return { ok: true };
    },
    async recon() {
      const rows = await db.query('select * from recon order by day desc limit 30');
      const per = await db.query(`select m.id, m.name, coalesce((select sum(amount) from deposits d where d.merchant_id = m.id and d.result = 'credited'), 0)::bigint deposits,
        coalesce((select sum(total) from customers c where c.merchant_id = m.id), 0)::bigint customers from merchants m order by m.created_at`);
      return { days: rows.map((r) => ({ day: iso(r.day).slice(0, 10), balances: r.balances, chain: r.chain, fees: r.fees, diff: r.diff, detail: r.detail })), merchants: per.map((p) => ({ id: p.id, name: p.name, deposits_total: p.deposits, customers_total: p.customers, ok: p.deposits === p.customers })) };
    },

    // ---------- 钱包 ----------
    async wallet() {
      const xpub = await getMeta(db, 'xpub');
      const [n] = await db.query('select count(*)::int n from customers');
      const info = async (a) => { if (!a) return null; try { const acc = await tron.account(a); return { address: a, trx: acc.trx, usdt: acc.trc20[tron.contract] || 0, activated: acc.activated }; } catch { return { address: a, error: true }; } };
      const r = await tron.resources(hot).catch(() => null);
      return { initialized: !!xpub, xpub_fingerprint: xpub ? xpub.slice(-8) : null, first_address: xpub ? deriveAddress(xpub, 0) : null, customers: n.n, network: tron.network, hot: await info(hot), cold: await info(cold), energy: r ? { left: Math.max(0, r.energyLimit - r.energyUsed), limit: r.energyLimit, per_sweep: ENERGY_PER_SWEEP } : null };
    },
    /** 初始化：只接受账户级公钥（xpub），并核对浏览器算出的第 1 个地址。只能做一次 */
    async 'wallet-init'(b, actor) {
      need(!(await getMeta(db, 'xpub')), 'already_initialized', 409);
      need(await verifyAdminCode(String(b.code || '')), 'bad_code', 400);
      let xpub;
      try { xpub = checkXpub(b.xpub); } catch (e) { throw new PayError(e.message === 'private_key_not_allowed' ? 'private_key_not_allowed' : 'invalid_xpub', 422, 'xpub'); }
      need(deriveAddress(xpub, 0) === String(b.first_address || ''), 'first_address_mismatch', 422, 'first_address');
      await setMeta(db, 'xpub', xpub);
      await audit(db, actor, 'wallet.init', xpub.slice(-8));
      return { ok: true, first_address: deriveAddress(xpub, 0) };
    },
  };

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const a = url.searchParams.get('a') || '';
      if (!actions[a]) return json(404, { error: { code: 'not_found' } });
      const isPost = request.method === 'POST';
      if (isPost && request.headers.get('x-qc-csrf') !== '1') return json(403, { error: { code: 'csrf' } });
      await requireAdmin(request);
      const b = isPost ? await readJson(request, 256 * 1024) : {};
      return json(200, money(await actions[a](b, 'admin', url.searchParams)));
    } catch (e) {
      if (e?.status === 401) return json(401, { error: { code: 'unauthorized' } });
      return errorResponse(e);
    }
  };
}

/**
 * 每分钟的任务里调用：归集分 3 步，每一步在上一步链上确认后才广播。
 * 第 2 步（转出 USDT）只在第 1 步成功后做；第 3 步（收回能量）只要第 1 步借出成功就要做，不论第 2 步结果如何。
 */
export async function sweepProgress(db, tron, { notify } = {}) {
  const batches = await db.query(`select * from sign_batches where kind = 'sweep' and status in ('stage1', 'stage2', 'stage3') order by created_at limit 10`);
  let moved = 0;
  for (const b of batches) {
    const plan = b.plan;
    const stage = Number(b.status.slice(-1));
    let pending = false;
    for (const s of plan.items.flatMap((it) => it.steps.filter((x) => x.stage === stage && x.status === 'broadcast'))) {
      const info = await tron.txInfo(s.txid).catch(() => null);
      if (!info) pending = true; else s.status = info.ok ? 'confirmed' : 'failed';
    }
    const save = (status) => db.query('update sign_batches set status = $3, plan = $2::jsonb, updated_at = now() where id = $1', [b.id, JSON.stringify(plan), status]);
    if (pending) { await save(b.status); continue; }
    if (stage === 2) {
      for (const it of plan.items) {
        const s = it.steps.find((x) => x.stage === 2);
        if (!s) continue;
        if (s.status === 'confirmed') {
          await db.query('update customers set onchain = greatest(0, onchain - $2), activated = true where address = $1', [it.address, it.amount]);
          await db.query(`update sweeps set status = 'done', txids = $3::jsonb where batch_id = $1 and address = $2`, [b.id, it.address, JSON.stringify({ usdt: s.txid })]);
        } else {
          await db.query(`update sweeps set status = 'failed' where batch_id = $1 and address = $2`, [b.id, it.address]);
          if (notify) await notify(`归集失败：${it.address}`, `批次 ${b.id} 里这个地址的 USDT 转账没有成功（${s.error || s.status}）。借出的能量会照常收回。`);
        }
      }
    }
    let status = 'done';
    for (let n = stage + 1; n <= 3; n++) {
      const next = plan.items.flatMap((it) => {
        const first = it.steps.find((x) => x.stage === 1);
        const ok = n === 3 ? first?.kind === 'delegate' && first.status === 'confirmed' : first?.status === 'confirmed';
        return ok ? it.steps.filter((x) => x.stage === n && !x.status) : [];
      });
      if (!next.length) continue;
      for (const s of next) {
        try { s.txid = await tron.broadcastHex(encodeSigned(s.rawHex, s.signature)); s.status = 'broadcast'; } catch (e) { s.status = 'failed'; s.error = e.message; }
      }
      if (next.some((x) => x.status === 'broadcast')) { status = `stage${n}`; break; }
    }
    if (status === 'done') await db.query(`update sweeps set status = 'failed' where batch_id = $1 and status in ('planned', 'broadcasting')`, [b.id]);
    await save(status);
    moved++;
  }
  return moved;
}
