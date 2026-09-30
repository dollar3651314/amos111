// v6 每分钟任务：扫链、回调（签名、重试、内网拦截）、提币确认、通知邮件合并
import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createTestDb } from '../src/pay/db.js';
import { migrate } from '../src/pay/schema.js';
import * as core from '../src/pay/core.js';
import { createFakeTron } from '../src/pay/fake-trongrid.js';
import { scan, runTick, notifyWithdrawals } from '../src/pay/tick.js';
import { signCallback, checkCallbackUrl, isPrivateIp, RETRY_MIN, resend } from '../src/pay/callbacks.js';

const U = 1_000_000;
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'").publicExtendedKey;
const HOT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const publicDns = async () => [{ address: '93.184.216.34' }];

async function setup() {
  const db = await createTestDb(); await migrate(db);
  await core.setMeta(db, 'xpub', XPUB);
  const m = await core.createMerchant(db, { id: 'm1', name: 'Acme', feeIn: { ppm: 10_000, fixed: 0, min: 0 }, feeOut: { ppm: 0, fixed: 2 * U, min: 0 } });
  const tron = createFakeTron({ pageSize: 3 });
  return { db, m, tron };
}

test('扫链：只入账转到客户地址的转账，翻页、游标前进，重复扫描不会重复入账', async () => {
  const { db, tron } = await setup();
  const c = await db.tx((t) => core.ensureCustomer(t, 'm1', 'u1'));
  const now = Date.now();
  await core.setMeta(db, 'scan_cursor', now - 120_000);
  for (let i = 0; i < 7; i++) tron.pay({ to: i % 2 ? c.address : HOT, amount: 10 * U, time: now - 60_000 + i * 1000 });
  const r = await scan(db, tron, { now });
  assert.equal(r.credited, 3);
  assert.ok(r.pages >= 3);
  assert.equal(r.complete, true);
  const again = await scan(db, tron, { now: now + 1000 });
  assert.equal(again.credited, 0);
  assert.equal((await db.query('select count(*)::int n from deposits'))[0].n, 3);
});

test('回调：带签名；失败按 1 分钟、5 分钟……重试；24 小时后停止；可以手动重发', async () => {
  const { db, tron } = await setup();
  const c = await db.tx((t) => core.ensureCustomer(t, 'm1', 'u1'));
  await core.setMeta(db, 'scan_cursor', Date.now() - 60_000);
  tron.pay({ to: c.address, amount: 20 * U, time: Date.now() - 1000 });
  const got = [];
  let reply = 500;
  const fetchImpl = async (url, init) => { got.push({ url, init }); return new Response('', { status: reply }); };
  const getTarget = async () => ({ url: 'https://merchant.example/cb', secret: 's3cret' });
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  assert.equal(got.length, 1);
  const h = got[0].init.headers;
  assert.equal(h['X-QC-Signature'], signCallback('s3cret', h['X-QC-Timestamp'], got[0].init.body));
  assert.equal(JSON.parse(got[0].init.body).type, 'deposit');
  // 回调里的金额是字符串，和开放 API 一致（BUG-P9）
  assert.equal(JSON.parse(got[0].init.body).data.amount, '20.00');
  let [cb] = await db.query('select * from callbacks');
  assert.equal(cb.attempts, 1);
  assert.ok(Math.abs(new Date(cb.next_at) - Date.now() - RETRY_MIN[0] * 60_000) < 5000);
  // 把它推到"所有重试都用完"
  await db.query(`update callbacks set attempts = $1, next_at = now()`, [RETRY_MIN.length]);
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  [cb] = await db.query('select * from callbacks');
  assert.equal(cb.status, 'failed');
  assert.ok(await resend(db, 'm1', cb.id));
  reply = 200;
  await runTick({ db, tron, getTarget, fetchImpl, resolve: publicDns });
  [cb] = await db.query('select * from callbacks');
  assert.equal(cb.status, 'ok');
});

test('回调地址：只允许 https，不允许内网地址', async () => {
  assert.equal(await checkCallbackUrl('http://merchant.example/cb', publicDns), 'https_required');
  assert.equal(await checkCallbackUrl('https://127.0.0.1/cb'), 'private_address');
  assert.equal(await checkCallbackUrl('https://internal.example/cb', async () => [{ address: '10.1.2.3' }]), 'private_address');
  assert.equal(await checkCallbackUrl('https://merchant.example/cb', publicDns), null);
  assert.ok(isPrivateIp('169.254.169.254') && isPrivateIp('::1') && isPrivateIp('fd00::1') && !isPrivateIp('8.8.8.8'));
});

test('提币：广播后链上确认才扣除冻结；新申请合并成一封邮件', async () => {
  const { db, m, tron } = await setup();
  const c = await db.tx((t) => core.ensureCustomer(t, 'm1', 'u1'));
  await core.recordDeposit(db, { txid: 'a'.repeat(64), logIndex: 0, block: 1, to: c.address, amount: 500 * U, time: new Date() });
  const w1 = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 100 * U, source: 'web' });
  const w2 = await core.requestWithdrawal(db, m, { kind: 'payout', to: HOT, amount: 50 * U, source: 'api' });
  const mails = [];
  const notify = async (subject, text) => mails.push({ subject, text });
  assert.equal(await notifyWithdrawals(db, notify, 'https://x/admin/'), 2);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /2 笔/);
  assert.equal(await notifyWithdrawals(db, notify, 'https://x/admin/'), 0);
  await core.markWithdrawal(db, w1.withdrawal_no, 'signing');
  await core.markWithdrawal(db, w1.withdrawal_no, 'broadcast', { txid: 'tx1' });
  await runTick({ db, tron, getTarget: async () => null, notify });
  assert.equal((await core.withdrawalView(db, w1.withdrawal_no)).status, 'broadcast'); // 还没确认
  tron.confirm('tx1', true);
  await runTick({ db, tron, getTarget: async () => null, notify });
  assert.equal((await core.withdrawalView(db, w1.withdrawal_no)).status, 'completed');
  const [b] = await db.query('select available, frozen from balances');
  assert.deepEqual(b, { available: 495 * U - 102 * U - 52 * U, frozen: 52 * U });
  void w2;
});
