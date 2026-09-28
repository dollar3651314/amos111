// 文件存储的统一接口：
//   mode                'vercel' | 'local'
//   head(pathname)      → { size, contentType } 或 null
//   read(pathname)      → { stream, contentType, size } 或 null
//   put(pathname, bytes, contentType)
//   del(pathnames[])
// 生产环境使用 Vercel Blob 私有存储（浏览器凭一次性凭证直传，见 api/kyb.js 的 onboarding / upload）；
// 本地和测试环境使用一个本地目录模拟，上传走 local-upload 接口。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

/**
 * token：有读写令牌时，每次调用都显式带上（v5）。@vercel/blob 默认优先使用平台认证（BLOB_STORE_ID），
 * 如果某个环境里同时存在别的存储的 BLOB_STORE_ID，服务端读写就会落到那个存储里，和浏览器直传用的存储不一致。
 * 显式传 token 可以保证：服务端读写的存储 = 浏览器直传凭证所属的存储（测试环境不会碰到生产存储）。
 */
export function createVercelBlobs({ token = '', load = () => import('@vercel/blob') } = {}) {
  const auth = token ? { token } : {};
  return {
    mode: 'vercel',
    async head(pathname) {
      const { head } = await load();
      try { const h = await head(pathname, auth); return { size: h.size, contentType: h.contentType }; } catch { return null; }
    },
    async read(pathname) {
      const { get } = await load();
      const r = await get(pathname, { access: 'private', useCache: false, ...auth });
      if (!r || r.statusCode !== 200) return null;
      return { stream: r.stream, contentType: r.blob.contentType, size: r.blob.size };
    },
    async put(pathname, bytes, contentType) {
      const { put } = await load();
      await put(pathname, bytes, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, ...auth });
    },
    async del(pathnames) {
      if (!pathnames.length) return;
      const { del } = await load();
      await del(pathnames, auth);
    },
  };
}

export function createLocalBlobs(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (pathname) => {
    const full = normalize(join(dir, pathname));
    if (!full.startsWith(normalize(dir))) throw new Error('bad pathname');
    return full;
  };
  return {
    mode: 'local',
    dir,
    async head(pathname) {
      const f = p(pathname);
      if (!existsSync(f)) return null;
      const meta = existsSync(f + '.meta') ? JSON.parse(readFileSync(f + '.meta', 'utf8')) : {};
      return { size: statSync(f).size, contentType: meta.contentType || 'application/octet-stream' };
    },
    async read(pathname) {
      const h = await this.head(pathname);
      if (!h) return null;
      return { stream: new Blob([readFileSync(p(pathname))]).stream(), ...h };
    },
    async put(pathname, bytes, contentType) {
      const f = p(pathname);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, bytes, { mode: 0o600 });
      writeFileSync(f + '.meta', JSON.stringify({ contentType }));
    },
    async del(pathnames) {
      for (const x of pathnames) { const f = p(x); rmSync(f, { force: true }); rmSync(f + '.meta', { force: true }); }
    },
  };
}
