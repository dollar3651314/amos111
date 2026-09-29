import crypto from 'node:crypto';

const BASE = process.env.QC_BASE || 'https://{BASE_URL}/api/v1/';
const KEY = process.env.QC_KEY, SECRET = process.env.QC_SECRET;

async function qc(method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = body ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const url = new URL(path, BASE);
  const toSign = [ts, method, url.pathname + url.search, bodyHash].join('\n');
  const sig = crypto.createHmac('sha256', SECRET).update(toSign).digest('hex');
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-QC-Key': KEY, 'X-QC-Timestamp': ts, 'X-QC-Signature': sig,
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: raw || undefined,
  });
  return res.json();
}

const order = await qc('POST', 'orders/', { customer_id: 'user_88213', merchant_order_no: `ACME-${Date.now()}`, amount: '100.00' });
console.log(order.pay_url);
