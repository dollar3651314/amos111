// 固定窗口限流，计数放在内存里；服务重启后清零（技术债 R1）。
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, Math.max(windowMs, 1000));
  sweep.unref();

  return {
    /** 记一次请求；返回 true 表示允许，false 表示超过限额。 */
    hit(key) {
      const t = now();
      let e = hits.get(key);
      if (!e || e.resetAt <= t) {
        e = { count: 0, resetAt: t + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return e.count <= max;
    },
    retryAfterSec(key) {
      const e = hits.get(key);
      return e ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 0;
    },
    stop() {
      clearInterval(sweep);
    },
  };
}
