// 所有配置都从环境变量读取，敏感信息不进代码仓库。
// 生产环境的变量在 Vercel 项目的 Environment Variables 里配置。
export function loadConfig(env = process.env) {
  const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
  return {
    rateLimitMax: int(env.RATE_LIMIT_MAX, 5),
    rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
    // Upstash Redis：通过 Vercel 市场集成开通后，Vercel 会自动注入 KV_REST_API_* 变量；
    // 也兼容 Upstash 官方的 UPSTASH_REDIS_REST_* 命名
    redis: {
      url: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '',
      token: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '',
    },
    // 邮件（D2）：配置了 RESEND_API_KEY 就用 Resend，否则使用 SMTP
    resendApiKey: env.RESEND_API_KEY || '',
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: env.SMTP_SECURE === '1',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
    mailFrom: env.MAIL_FROM || '',
    mailTo: env.MAIL_TO || '',
  };
}
