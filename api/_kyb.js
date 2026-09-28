// v3 开户（KYB）接口的公共初始化。文件名以 _ 开头，Vercel 不会把它当作接口。
import { Redis } from '@upstash/redis';
import { waitUntil, ipAddress } from '@vercel/functions';
import { loadConfig } from '../lead-api/src/config.js';
import { createRawSender } from '../lead-api/src/mailer.js';
import { deriveKeys } from '../lead-api/src/kyb/crypto.js';
import { createRepo } from '../lead-api/src/kyb/repo.js';
import { createVercelBlobs, createLocalBlobs } from '../lead-api/src/kyb/blobs.js';
import { createOnboardingHandler } from '../lead-api/src/kyb/onboarding.js';
import { createAdminHandler, createCleanup } from '../lead-api/src/kyb/admin.js';
import { json } from '../lead-api/src/kyb/http.js';

let deps;
export function kybDeps() {
  if (deps) return deps;
  const config = loadConfig();
  if (!config.redis.url || !config.redis.token) throw new Error('storage not configured');
  const keys = deriveKeys(config.appSecret);
  const redis = new Redis({ url: config.redis.url, token: config.redis.token });
  const blobs = config.blobConfigured ? createVercelBlobs() : config.localBlobDir ? createLocalBlobs(config.localBlobDir) : null;
  const repo = createRepo({ redis, keys });
  const send = createRawSender(config);
  const getIp = (req) => ipAddress(req) || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '';
  deps = {
    onboarding: createOnboardingHandler({ repo, blobs, send, config, waitUntil, getIp }),
    admin: createAdminHandler({ repo, blobs, send, redis, keys, config }),
    cleanup: createCleanup({ repo, blobs }),
    config,
  };
  return deps;
}

/** 初始化失败（例如缺少 APP_SECRET）时安全失败：不泄露任何配置信息 */
export async function run(fn) {
  try { return await fn(kybDeps()); }
  catch (err) { console.error(`[kyb] init failed: ${err.message}`); return json(503, { ok: false, error: 'not_configured' }); }
}
