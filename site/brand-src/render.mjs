// 用 Playwright 把 SVG 和 HTML 渲染成 PNG，并生成 favicon.ico（内嵌 PNG 格式的 ICO）。
// 用法：node brand-src/render.mjs（在 site/ 目录下运行）
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const mark = readFileSync('public/favicon.svg', 'utf8');

async function svgPng(size, pad = 0, bg = 'transparent') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">
    <div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${mark.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`);
  return page.screenshot({ omitBackground: bg === 'transparent' });
}

writeFileSync('public/apple-touch-icon.png', await svgPng(180, 18, '#0B1F3A'));
writeFileSync('public/brand/quickcome-mark-512.png', await svgPng(512));
const ico32 = await svgPng(32);
// ICO 文件头 + 1 个目录项 + PNG 数据
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt8(32, 6); header.writeUInt8(32, 7); header.writeUInt8(0, 8); header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(ico32.length, 14); header.writeUInt32LE(22, 18);
writeFileSync('public/favicon.ico', Buffer.concat([header, ico32]));

await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(readFileSync('brand-src/og.html', 'utf8'));
writeFileSync('public/og-image.png', await page.screenshot());
await browser.close();
console.log('brand assets rendered');
