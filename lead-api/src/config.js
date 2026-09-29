// 所有配置都从环境变量读取，敏感信息不进代码仓库。
// 生产环境的变量在 Vercel 项目的 Environment Variables 里配置。
export function loadConfig(rawEnv = process.env) {
  // 去掉首尾空白：从终端或密码管理器复制时，容易带上换行（v3 上线时 CRON_SECRET 就因此导致部署失败）
  const env = new Proxy(rawEnv, { get: (o, k) => (typeof o[k] === 'string' ? o[k].trim() : o[k]) });
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
    // v3：开户（KYB）
    appSecret: env.APP_SECRET || '',
    adminSetupToken: env.ADMIN_SETUP_TOKEN || '',
    cronSecret: env.CRON_SECRET || '',
    blobConfigured: Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID),
    // 浏览器直传需要签发上传凭证，这一步只支持读写令牌（BLOB_READ_WRITE_TOKEN），不支持 OIDC
    blobUploadToken: Boolean(env.BLOB_READ_WRITE_TOKEN),
    blobToken: env.BLOB_READ_WRITE_TOKEN || '',
    localBlobDir: env.LOCAL_BLOB_DIR || '',
    // 当前环境（agents v0.6 C34）：production / staging / preview / local
    appEnv: env.APP_ENV || env.VERCEL_ENV || 'local',
    // v6 收付款
    databaseUrl: env.DATABASE_URL || '',
    localDbDir: env.LOCAL_DB_DIR || '', // 本地和自动化测试：内嵌 Postgres 的数据目录
    tronNetwork: env.TRON_NETWORK || 'mainnet',
    tronApiKey: env.TRONGRID_API_KEY || '',
    usdtContract: env.USDT_CONTRACT || '',
    tickSecret: env.TICK_SECRET || '',
    fakeTron: env.FAKE_TRON === '1', // 本地和自动化测试：用 TronGrid 替身
    mailFrom: env.MAIL_FROM || '',
    mailTo: env.MAIL_TO || '',
  };
}
