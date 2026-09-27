// 限流器的统一接口：limit(key) → Promise<{ success, resetAt }>，resetAt 为毫秒时间戳。

/** 内存版：固定窗口计数，用于本地开发和测试。多个实例之间不共享计数。 */
export function createMemoryLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    async limit(key) {
      const t = now();
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      let e = hits.get(key);
      if (!e) {
        e = { count: 0, resetAt: t + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return { success: e.count <= max, resetAt: e.resetAt };
    },
  };
}

/** Upstash 版：固定窗口，计数存放在 Redis 中，所有函数实例共享（生产环境使用）。 */
export async function createUpstashLimiter({ redis, max, windowMs }) {
  const { Ratelimit } = await import('@upstash/ratelimit');
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(max, `${Math.round(windowMs / 1000)} s`),
    prefix: 'qc:rl',
  });
  return {
    async limit(key) {
      const r = await rl.limit(key);
      return { success: r.success, resetAt: r.reset };
    },
  };
}
