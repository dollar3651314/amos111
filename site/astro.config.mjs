import { defineConfig } from 'astro/config';

// 站点地址（用于 canonical、sitemap、分享卡片）的取值顺序：
//   1. 环境变量 SITE_URL（手动指定）
//   2. Vercel 构建时提供的 VERCEL_PROJECT_PRODUCTION_URL：有自定义域名时是自定义域名，否则是 Vercel 默认的 *.vercel.app 域名
//      （v2.2：Amos 暂时不买域名，先用 Vercel 默认域名；以后在 Vercel 添加 quickcomepay.com 后会自动切换）
//   3. 本地和测试构建：https://quickcomepay.com
const SITE =
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://quickcomepay.com');

export default defineConfig({
  site: SITE,
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // CSS 一律输出为外部文件，这样 CSP 可以禁止内联样式和内联脚本
    inlineStylesheets: 'never',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
