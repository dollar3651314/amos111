import { defineConfig } from 'astro/config';

// 站点正式域名（Amos 已认可 quickcomepay.com）。
// 部署前可以通过环境变量 SITE_URL 覆盖。
export default defineConfig({
  site: process.env.SITE_URL || 'https://quickcomepay.com',
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
