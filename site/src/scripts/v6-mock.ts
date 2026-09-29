// v6 原型的模拟数据（全部虚构）。商户后台、付款页面和运营后台共用，格式与正式接口一致。
// ?empty=1 时返回空数据，用来确认空状态（agents v0.5.1 C32）。
import { calcFee, type FeeRule } from '../lib/money';

export const EMPTY = new URLSearchParams(location.search).get('empty') === '1';
const U = 1_000_000;
const now = Date.now();
export const ago = (min: number) => new Date(now - min * 60_000).toISOString();

// 固定种子的伪随机数，保证每次打开看到的数据一样
let seed = 20260929;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const fakeAddr = () => 'T' + Array.from({ length: 33 }, () => B58[Math.floor(rnd() * 58)]).join('');
export const fakeTx = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

export interface Merchant { id: string; name: string; status: 'active' | 'disabled'; feeIn: FeeRule; feeOut: FeeRule; available: number; frozen: number; addresses: number; ipWhitelist: string[]; cashoutWallets: string[]; since: string }
export const merchants: Merchant[] = EMPTY ? [] : [
  { id: 'm1', name: 'Acme Export Ltd', status: 'active', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, available: 48_215_400_000, frozen: 1_002_000_000, addresses: 214, ipWhitelist: ['203.0.113.10'], cashoutWallets: [fakeAddr()], since: ago(60 * 24 * 20) },
  { id: 'm2', name: 'Delta Trading Co.', status: 'active', feeIn: { ppm: 8000, fixed: 0, min: 500_000 }, feeOut: { ppm: 1000, fixed: 1 * U, min: 0 }, available: 12_380_120_000, frozen: 332_330_000, addresses: 96, ipWhitelist: [], cashoutWallets: [fakeAddr()], since: ago(60 * 24 * 12) },
  { id: 'm3', name: 'Sunrise Co', status: 'active', feeIn: { ppm: 0, fixed: 1 * U, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, available: 906_200_000, frozen: 0, addresses: 12, ipWhitelist: [], cashoutWallets: [], since: ago(60 * 24 * 3) },
  { id: 'm4', name: 'Northwind Manufacturing Co.', status: 'disabled', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, available: 0, frozen: 0, addresses: 3, ipWhitelist: [], cashoutWallets: [], since: ago(60 * 24 * 30) },
];
/** 开户已通过、还没开通收付款的企业（来自 v3 开户申请） */
export const approvedApps = EMPTY ? [] : [{ id: 'a0', ref: 'QC-2026-0000', company: 'Harbor Legacy Ltd', email: 'finance@harbor-legacy.example' }];

// ---------- 当前商户（商户后台只看得到 Acme Export） ----------
export const me = merchants[0] || { id: 'm1', name: 'Acme Export Ltd', status: 'active', feeIn: { ppm: 10000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 }, available: 0, frozen: 0, addresses: 0, ipWhitelist: [], cashoutWallets: [fakeAddr()], since: ago(1) };
if (EMPTY) { me.available = 0; me.frozen = 0; }

export type OrderStatus = 'pending' | 'completed' | 'partial' | 'overpaid' | 'expired';
export interface Order { id: string; merchantNo: string; amount: number; received: number; address: string; status: OrderStatus; createdAt: string; expiresAt: string; confirmations?: number }
const ord = (i: number, amount: number, received: number, status: OrderStatus, minAgo: number, ttl = 30): Order => ({
  id: `ORD-20260929-${String(412 - i).padStart(4, '0')}`, merchantNo: `ACME-${88100 + 412 - i}`, amount, received, address: fakeAddr(), status,
  createdAt: ago(minAgo), expiresAt: ago(minAgo - ttl),
});
export const orders: Order[] = EMPTY ? [] : [
  ord(0, 500 * U, 0, 'pending', 6), ord(1, 1_000 * U, 0, 'pending', 12), ord(2, 250 * U, 0, 'pending', 27),
  ord(3, 500 * U, 500 * U, 'completed', 40), ord(4, 298_500_000, 150 * U, 'partial', 55), ord(5, 120 * U, 130 * U, 'overpaid', 80),
  ord(6, 80 * U, 0, 'expired', 200), ord(7, 2_000 * U, 2_000 * U, 'completed', 260), ord(8, 60 * U, 59_900_000, 'completed', 300),
];

export type DepResult = 'confirming' | 'credited' | 'below_min' | 'late';
export interface Deposit { id: string; time: string; txid: string; address: string; amount: number; fee: number; kind: 'order' | 'userid'; ref: string; result: DepResult; orderStatus?: OrderStatus; confirmations?: number; merchant: string }
const dep = (minAgo: number, amount: number, kind: 'order' | 'userid', ref: string, result: DepResult, orderStatus?: OrderStatus, confirmations?: number): Deposit => ({
  id: 'd' + minAgo, time: ago(minAgo), txid: fakeTx(), address: fakeAddr(), amount, fee: result === 'credited' || result === 'late' ? calcFee(amount, me.feeIn) : 0, kind, ref, result, orderStatus, confirmations, merchant: me.name,
});
export const deposits: Deposit[] = EMPTY ? [] : [
  dep(1, 1_000 * U, 'order', 'ORD-20260929-0401', 'confirming', undefined, 12),
  dep(8, 500 * U, 'order', 'ORD-20260929-0409', 'credited', 'completed'),
  dep(11, 1_200 * U, 'userid', 'user_88213', 'credited'),
  dep(19, 150 * U, 'order', 'ORD-20260929-0408', 'credited', 'partial'),
  dep(33, 130 * U, 'order', 'ORD-20260929-0407', 'credited', 'overpaid'),
  dep(47, 300_000, 'userid', 'user_10442', 'below_min'),
  dep(90, 80 * U, 'order', 'ORD-20260929-0406', 'late'),
  dep(130, 2_000 * U, 'order', 'ORD-20260929-0405', 'credited', 'completed'),
  dep(260, 3_450 * U, 'userid', 'user_77120', 'credited'),
];

export interface UseridAddr { userid: string; address: string; received: number; createdAt: string }
export const useridAddrs: UseridAddr[] = EMPTY ? [] : [
  { userid: 'user_88213', address: fakeAddr(), received: 9_620 * U, createdAt: ago(60 * 24 * 18) },
  { userid: 'user_77120', address: fakeAddr(), received: 3_450 * U, createdAt: ago(60 * 24 * 9) },
  { userid: 'user_10442', address: fakeAddr(), received: 300_000, createdAt: ago(60 * 24 * 2) },
];
export interface PoolAddr { address: string; state: 'busy' | 'cooling' | 'free'; order?: string; until?: string }
export const pool: PoolAddr[] = EMPTY ? [] : [
  ...orders.filter((o) => o.status === 'pending').map((o) => ({ address: o.address, state: 'busy' as const, order: o.id })),
  { address: fakeAddr(), state: 'cooling', order: 'ORD-20260929-0409', until: ago(-60 * 23) },
  { address: fakeAddr(), state: 'cooling', order: 'ORD-20260929-0406', until: ago(-60 * 20) },
  { address: fakeAddr(), state: 'free' }, { address: fakeAddr(), state: 'free' },
];

export type LedgerType = 'deposit' | 'fee_in' | 'freeze' | 'unfreeze' | 'withdraw' | 'fee_out';
export interface Ledger { time: string; type: LedgerType; amount: number; balance: number; ref: string }
export const ledger: Ledger[] = (() => {
  if (EMPTY) return [];
  const rows: Ledger[] = [];
  let bal = me.available;
  const push = (time: string, type: LedgerType, amount: number, ref: string) => { rows.push({ time, type, amount, balance: bal, ref }); bal -= amount; };
  push(ago(14), 'freeze', -1_002 * U, 'WD-0031');
  for (const d of deposits.filter((x) => x.result === 'credited' || x.result === 'late')) { push(d.time, 'fee_in', -d.fee, d.ref); push(d.time, 'deposit', d.amount, d.ref); }
  return rows;
})();

export type WdStatus = 'pending' | 'rejected' | 'cancelled' | 'signing' | 'broadcast' | 'completed' | 'failed';
export interface Withdrawal { id: string; merchant: string; merchantId: string; kind: 'payout' | 'cashout'; to: string; amount: number; fee: number; source: 'web' | 'api'; status: WdStatus; time: string; txid?: string; reason?: string }
export const withdrawals: Withdrawal[] = EMPTY ? [] : [
  { id: 'WD-0031', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', to: fakeAddr(), amount: 1_000 * U, fee: 2 * U, source: 'web', status: 'pending', time: ago(14) },
  { id: 'WD-0030', merchant: 'Delta Trading Co.', merchantId: 'm2', kind: 'payout', to: fakeAddr(), amount: 250 * U, fee: 1_250_000, source: 'api', status: 'pending', time: ago(22) },
  { id: 'WD-0029', merchant: 'Delta Trading Co.', merchantId: 'm2', kind: 'payout', to: fakeAddr(), amount: 80 * U, fee: 1_080_000, source: 'api', status: 'pending', time: ago(31) },
  { id: 'WD-0028', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', to: fakeAddr(), amount: 350 * U, fee: 2 * U, source: 'api', status: 'completed', time: ago(220), txid: fakeTx() },
  { id: 'WD-0027', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'cashout', to: me.cashoutWallets[0], amount: 20_000 * U, fee: 2 * U, source: 'web', status: 'completed', time: ago(60 * 16), txid: fakeTx() },
  { id: 'WD-0026', merchant: 'Acme Export Ltd', merchantId: 'm1', kind: 'payout', to: fakeAddr(), amount: 45 * U, fee: 2 * U, source: 'web', status: 'rejected', time: ago(60 * 30), reason: '收款地址与付款说明不符 / Address does not match the payment note' },
];

export type CbEvent = 'deposit' | 'order' | 'withdrawal';
export interface Callback { id: string; time: string; event: CbEvent; ref: string; attempts: number; result: 'ok' | 'retrying' | 'failed'; code: number | null; next?: string }
export const callbacks: Callback[] = EMPTY ? [] : [
  { id: 'evt_9f2a01', time: ago(8), event: 'deposit', ref: 'ORD-20260929-0409', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f2a02', time: ago(8), event: 'order', ref: 'ORD-20260929-0409', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f29f7', time: ago(11), event: 'deposit', ref: 'user_88213', attempts: 3, result: 'retrying', code: 502, next: ago(-24) },
  { id: 'evt_9f29c1', time: ago(14), event: 'withdrawal', ref: 'WD-0031', attempts: 1, result: 'ok', code: 200 },
  { id: 'evt_9f2811', time: ago(60 * 26), event: 'deposit', ref: 'user_77120', attempts: 8, result: 'failed', code: null },
];

// ---------- 运营后台：归集 ----------
export interface SweepRow { id: string; merchant: string; kind: string; address: string; balance: number; lastDeposit: string; activated: boolean }
export const sweepRows: SweepRow[] = EMPTY ? [] : [
  { id: 's1', merchant: 'Acme Export Ltd', kind: 'userid · user_88213', address: fakeAddr(), balance: 8_420 * U, lastDeposit: ago(11), activated: true },
  { id: 's2', merchant: 'Acme Export Ltd', kind: 'order', address: fakeAddr(), balance: 2_300 * U, lastDeposit: ago(40), activated: false },
  { id: 's3', merchant: 'Acme Export Ltd', kind: 'userid · user_77120', address: fakeAddr(), balance: 3_450 * U, lastDeposit: ago(260), activated: true },
  { id: 's4', merchant: 'Delta Trading Co.', kind: 'userid · 10293', address: fakeAddr(), balance: 1_150 * U, lastDeposit: ago(95), activated: true },
  { id: 's5', merchant: 'Delta Trading Co.', kind: 'order', address: fakeAddr(), balance: 610 * U, lastDeposit: ago(130), activated: true },
  { id: 's6', merchant: 'Delta Trading Co.', kind: 'order', address: fakeAddr(), balance: 2_549_800_000, lastDeposit: ago(300), activated: true },
  { id: 's7', merchant: 'Sunrise Co', kind: 'userid · s-551', address: fakeAddr(), balance: 6_200_000, lastDeposit: ago(60 * 30), activated: true },
];
export const wallet = {
  initialized: !EMPTY,
  hot: { address: fakeAddr(), usdt: 4_120 * U, trx: 3_210 * U, stakedTrx: 60_000 * U, energy: 420_000, energyMax: 820_000 },
  cold: { address: fakeAddr(), usdt: 250_000 * U },
  firstAddress: fakeAddr(),
};
/** 一笔 USDT 转账到已经有 USDT 的地址，大约需要的能量；燃烧 TRX 时大约需要的 TRX（按链上实时价格计算，这里是示意） */
export const ENERGY_PER_SWEEP = 65_000;
export const BURN_TRX_PER_SWEEP = 6.9;
export const ACTIVATE_TRX = 1.1;

export interface Anomaly { id: string; time: string; type: 'token' | 'late' | 'below_min' | 'duplicate'; merchant: string; address: string; amount: string; ref: string; handled: boolean }
export const anomalies: Anomaly[] = EMPTY ? [] : [
  { id: 'x1', time: ago(47), type: 'below_min', merchant: 'Acme Export Ltd', address: fakeAddr(), amount: '0.30 USDT', ref: 'user_10442', handled: false },
  { id: 'x2', time: ago(90), type: 'late', merchant: 'Acme Export Ltd', address: fakeAddr(), amount: '80.00 USDT', ref: 'ORD-20260929-0406', handled: false },
  { id: 'x3', time: ago(60 * 20), type: 'token', merchant: 'Delta Trading Co.', address: fakeAddr(), amount: '15.00 USDC', ref: 'userid · 10293', handled: false },
  { id: 'x4', time: ago(60 * 50), type: 'duplicate', merchant: 'Sunrise Co', address: fakeAddr(), amount: '100.00 USDT', ref: 'ORD-20260927-0031', handled: true },
];

export interface Recon { date: string; balances: number; chain: number; fees: number; diff: number }
export const recon: Recon[] = EMPTY ? [] : [0, 1, 2, 3, 4, 5, 6].map((i) => {
  const balances = 61_503_720_000 - i * 3_100_000_000;
  const fees = 1_200_000_000 + i * 20_000_000;
  const diff = i === 3 ? -12_000_000 : 0;
  return { date: new Date(now - (i + 1) * 864e5).toISOString().slice(0, 10), balances, chain: balances + fees + diff, fees, diff };
});

export const quota = [
  { key: 'vercelReq', name: 'Vercel 请求数（本月）', used: 231_400, limit: 1_000_000, unit: '次' },
  { key: 'vercelCpu', name: 'Vercel CPU 时间（本月）', used: 0.74, limit: 4, unit: '小时' },
  { key: 'db', name: 'Supabase 存储', used: 156, limit: 500, unit: 'MB' },
  { key: 'trongrid', name: 'TronGrid 请求（今天）', used: 11_820, limit: 100_000, unit: '次' },
];
