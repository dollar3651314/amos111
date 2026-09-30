// v6 运营后台的登录检查：沿用开户后台（v3）的管理员账号（保存在 Upstash 的 qc:admin），
// 所以 Amos 只有一套密码和验证器。签名前的验证码也用这一个验证器，并且同一个码不能用两次。
import { readSession } from '../kyb/auth.js';
import { decryptJson } from '../kyb/crypto.js';
import { totpStep } from '../kyb/totp.js';

export function createAdminGate({ redis, kybKeys, now = () => Date.now() }) {
  const getAdmin = async () => { const raw = await redis.get('qc:admin'); return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; };
  return {
    async requireAdmin(request) {
      const admin = await getAdmin();
      if (!admin || !readSession(kybKeys.session, request.headers.get('cookie'), admin.version, now())) throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
    async verifyAdminCode(code) {
      const admin = await getAdmin();
      if (!admin) return false;
      const step = totpStep(decryptJson(kybKeys.enc, admin.totp), code, now());
      if (step < 0 || step <= Number((await redis.get('qc:admin:totp-last')) || 0)) return false;
      await redis.set('qc:admin:totp-last', String(step), { ex: 180 });
      return true;
    },
  };
}
