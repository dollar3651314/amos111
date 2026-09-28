// 测试环境（v2）：模拟 SMTP 服务器 + 两个本地服务器实例（lead-api/src/local-server.js，模拟 Vercel 的行为：
// 提供静态文件、按 vercel.json 输出响应头、由平台层写入 x-real-ip，/api 使用与生产相同的 handler）
// 端口：8080 主实例（放宽限流）、3002 默认限流配置实例（专门用来验证 AC7）、2525 SMTP
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const TMP = resolve(HERE, '.tmp');
export const MAILS = resolve(TMP, 'mails.jsonl');
export const DATA_MAIN = resolve(TMP, 'data-main');
export const DATA_RL = resolve(TMP, 'data-ratelimit');
export const DATA_PROTO = resolve(TMP, 'data-prototype');
export const PROTO_DIST = resolve(TMP, 'proto-dist');
// v3 开户（KYB）测试用的密钥：只用于本地测试
export const KYB_ENV = { APP_SECRET: 'e2e-app-secret-e2e-app-secret-0123456789ab', ADMIN_SETUP_TOKEN: 'e2e-setup-token', CRON_SECRET: 'e2e-cron-secret' };
const children = [];

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function startLocal(port, dataDir, extraEnv = {}) {
  const p = spawn(process.execPath, ['lead-api/src/local-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: '0', RESEND_API_KEY: '',
      MAIL_FROM: 'Quick Come Website <no-reply@quickcomepay.test>', MAIL_TO: 'sales@quickcomepay.test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = resolve(TMP, `local-${port}.log`);
  p.stdout.on('data', (d) => appendFileSync(log, d));
  p.stderr.on('data', (d) => appendFileSync(log, d));
  children.push(p);
}

export async function start() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        appendFileSync(MAILS, JSON.stringify({ to: session.envelope.rcptTo.map((r) => r.address), raw }) + '\n');
        cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));

  startLocal(8080, DATA_MAIN, { RATE_LIMIT_MAX: '1000', ...KYB_ENV });
  startLocal(3002, DATA_RL); // 默认配置：10 分钟 5 次

  // AC13：用原型模式另外构建一份（与 Vercel 预览环境相同），放在 8090 端口
  execFileSync(process.execPath, [resolve(ROOT, 'site/node_modules/astro/bin/astro.mjs'), 'build', '--outDir', PROTO_DIST],
    { cwd: resolve(ROOT, 'site'), env: { ...process.env, PROTOTYPE: '1' }, stdio: 'pipe' });
  startLocal(8090, DATA_PROTO, { SITE_DIR: PROTO_DIST });

  await Promise.all([waitFor('http://127.0.0.1:8080/api/health/'), waitFor('http://127.0.0.1:3002/api/health/'), waitFor('http://127.0.0.1:8090/api/health/')]);
  return async () => {
    for (const c of children) c.kill('SIGTERM');
    await new Promise((r) => smtp.close(r));
  };
}

// 解码邮件正文里的 quoted-printable（=3D、软换行）
export const decodeQP = (raw) => Buffer.from(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');

export const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
