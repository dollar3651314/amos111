// 测试环境：模拟 SMTP 服务器 + 两个 lead-api 实例 + 真实 Nginx（使用 deploy/nginx 下的生产配置片段）
// 端口：8080 Nginx（入口）、3001 lead-api（主实例，放宽限流，经 Nginx 访问）、
//       3002 lead-api（默认限流配置，专门用来验证 AC7）、2525 SMTP
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const TMP = resolve(HERE, '.tmp');
export const MAILS = resolve(TMP, 'mails.jsonl');
export const DATA_MAIN = resolve(TMP, 'data-main');
export const DATA_RL = resolve(TMP, 'data-ratelimit');
const children = [];

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function startLeadApi(port, dataDir, extraEnv = {}) {
  const p = spawn(process.execPath, ['src/index.js'], {
    cwd: resolve(ROOT, 'lead-api'),
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, TRUST_PROXY: '1',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: '0',
      MAIL_FROM: 'Quick Come Website <no-reply@quickcomepay.test>', MAIL_TO: 'sales@quickcomepay.test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = resolve(TMP, `lead-api-${port}.log`);
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

  startLeadApi(3001, DATA_MAIN, { RATE_LIMIT_MAX: '1000' });
  startLeadApi(3002, DATA_RL); // 默认配置：10 分钟 5 次

  const nginxConf = `
worker_processes 1;
pid ${TMP}/nginx.pid;
error_log ${TMP}/nginx-error.log warn;
events {}
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log ${TMP}/nginx-access.log;
  client_body_temp_path ${TMP}/nginx-body;
  proxy_temp_path ${TMP}/nginx-proxy;
  include ${ROOT}/deploy/nginx/quickcome-http.conf;
  server {
    listen 127.0.0.1:8080;
    server_name localhost;
    root ${ROOT}/site/dist;
    include ${ROOT}/deploy/nginx/quickcome-site.conf;
  }
}`;
  writeFileSync(resolve(TMP, 'nginx.conf'), nginxConf);
  execFileSync('nginx', ['-t', '-c', resolve(TMP, 'nginx.conf')], { stdio: 'pipe' });
  execFileSync('nginx', ['-c', resolve(TMP, 'nginx.conf')]);

  await Promise.all([
    waitFor('http://127.0.0.1:3001/api/health'),
    waitFor('http://127.0.0.1:3002/api/health'),
    waitFor('http://127.0.0.1:8080/api/health'),
  ]);
  return async () => {
    try { execFileSync('nginx', ['-c', resolve(TMP, 'nginx.conf'), '-s', 'stop']); } catch {}
    for (const c of children) c.kill('SIGTERM');
    await new Promise((r) => smtp.close(r));
  };
}

export const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
