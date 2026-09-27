// 所有配置都从环境变量读取，敏感信息不进代码仓库。
export function loadConfig(env = process.env) {
  const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
  return {
    port: int(env.PORT, 3001),
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || './data',
    trustProxy: env.TRUST_PROXY === '1',
    rateLimitMax: int(env.RATE_LIMIT_MAX, 5),
    rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
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
