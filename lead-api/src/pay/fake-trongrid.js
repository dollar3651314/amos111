// v6 TronGrid 的本地替身：接口和 trongrid.js 相同，数据放在内存里。只用于本地开发和自动化测试（测试预审 TP6-2）。
// 本地服务器还提供 /__fake/tron/* 地址，端到端测试用它"模拟一笔链上转账"。
import { randomBytes } from 'node:crypto';

export function createFakeTron({ network = 'nile', contract = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', pageSize = 200 } = {}) {
  const events = [];
  const txs = new Map(); // txid → { ok }
  const accounts = new Map(); // address → { activated, trx, trc20 }
  let block = 1_000_000;
  const tx = () => randomBytes(32).toString('hex');
  return {
    network, contract, events, txs, accounts,
    /** 测试用：模拟一笔已确认的 USDT 转账 */
    pay({ to, amount, from = 'TMa7yK2d9Qp4XvB8sN1cF6rH3wZ5jL0eUt', time = Date.now(), txid = tx(), logIndex = 0 }) {
      const e = { txid, logIndex, block: ++block, time, from, to, amount };
      events.push(e); events.sort((a, b) => a.time - b.time);
      return e;
    },
    async transfers({ minTs, maxTs, fingerprint }) {
      const all = events.filter((e) => e.time >= minTs && e.time <= maxTs);
      const start = fingerprint ? Number(fingerprint) : 0;
      const page = all.slice(start, start + pageSize);
      return { events: page, next: start + pageSize < all.length ? String(start + pageSize) : null };
    },
    async solidBlock() { return { number: block, time: Date.now() }; },
    async txInfo(txid) { const t = txs.get(txid); return t ? { ok: t.ok, fee: 0, energy: 65_000, block } : null; },
    async account(address) { return accounts.get(address) || { activated: false, trx: 0, trc20: {} }; },
    async resources() { return { energyLimit: 820_000, energyUsed: 400_000 }; },
    async chainParams() { return [{ key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 }]; },
    async buildUsdtTransfer(p) { return fakeTx('TriggerSmartContract', p); },
    async buildTrxTransfer(p) { return fakeTx('TransferContract', p); },
    async buildDelegate(p) { return fakeTx(p.undelegate ? 'UnDelegateResourceContract' : 'DelegateResourceContract', p); },
    async broadcast(signed) { txs.set(signed.txID, txs.get(signed.txID) || { ok: true, pending: true }); return signed.txID; },
    /** 测试用：让一笔已广播的交易"确认" */
    confirm(txid, ok = true) { txs.set(txid, { ok }); },
  };
}
function fakeTx(type, p) {
  const txID = randomBytes(32).toString('hex');
  return { txID, raw_data: { contract: [{ type, parameter: { value: p } }], expiration: Date.now() + 30 * 60_000 }, raw_data_hex: '', fake: true };
}
