// v6 签名和验签（浏览器和服务器共用）。签名格式：r(32) + s(32) + 恢复位(1，取值 0 或 1)，
// 和 TRON 主网上的真实交易一致（测试里用主网的真实交易验证过）。
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hex } from '@scure/base';
import { toAddress } from './txcodec.js';

export function addressOfPublicKey(pub) {
  const raw = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  const h = keccak_256(raw.slice(1));
  const b = new Uint8Array(21); b[0] = 0x41; b.set(h.slice(-20), 1);
  return toAddress(b);
}
export const addressOfPrivateKey = (priv) => addressOfPublicKey(secp256k1.getPublicKey(priv, false));

/** 签名交易哈希（txID），返回 130 位十六进制 */
export function signTxId(txIdHex, priv) {
  const s = secp256k1.sign(hex.decode(txIdHex), priv, { lowS: true });
  return hex.encode(s.toCompactRawBytes()) + s.recovery.toString(16).padStart(2, '0');
}
/** 从签名恢复出签名人的地址；签名格式不对时返回 null */
export function signerOf(txIdHex, sigHex) {
  try {
    if (!/^[0-9a-f]{130}$/i.test(sigHex)) return null;
    const v = parseInt(sigHex.slice(128), 16);
    const rec = v >= 27 ? v - 27 : v;
    if (rec !== 0 && rec !== 1) return null;
    const pub = secp256k1.Signature.fromCompact(sigHex.slice(0, 128)).addRecoveryBit(rec).recoverPublicKey(hex.decode(txIdHex)).toRawBytes(false);
    return addressOfPublicKey(pub);
  } catch { return null; }
}
