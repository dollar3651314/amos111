// TC-21 (AC10) 首页和联系页（中英两版），用 Lighthouse 移动端模式检测。
// 阈值：性能 ≥ 85，可访问性 ≥ 90，最佳实践 ≥ 90，SEO ≥ 90。
// 说明：本地测试环境没有 HTTPS，所以跳过 is-on-https 和 redirects-http 两项（生产环境由 verify.sh 覆盖）；
//       canonical 指向正式域名，本地地址和它不一致，所以同样跳过 canonical 这一项。
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { writeFileSync, mkdirSync } from 'node:fs';
import { start, TMP } from './stack.mjs';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const TH = { performance: 85, accessibility: 90, 'best-practices': 90, seo: 90 };
const URLS = ['/', '/contact/', '/zh/', '/zh/contact/'];

const stop = await start();
mkdirSync(`${TMP}/lighthouse`, { recursive: true });
const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: ['--headless=new', '--no-sandbox'] });
let fail = false;
const rows = [];
try {
  for (const path of URLS) {
    const r = await lighthouse(`http://127.0.0.1:8080${path}`, {
      port: chrome.port, output: 'html', logLevel: 'error', formFactor: 'mobile',
      skipAudits: ['is-on-https', 'redirects-http', 'canonical'],
    });
    writeFileSync(`${TMP}/lighthouse/${path.replace(/\//g, '_') || 'home'}.html`, r.report);
    const s = Object.fromEntries(Object.entries(r.lhr.categories).map(([k, v]) => [k, Math.round(v.score * 100)]));
    const ok = Object.entries(TH).every(([k, min]) => s[k] >= min);
    if (!ok) fail = true;
    rows.push({ path, ...s, pass: ok ? '✅' : '❌' });
    const failed = Object.values(r.lhr.audits).filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode === 'binary');
    if (failed.length) console.log(path, '未通过的单项:', failed.map((a) => a.id).join(', '));
  }
} finally {
  await chrome.kill();
  await stop();
}
console.table(rows);
writeFileSync(`${TMP}/lighthouse/summary.json`, JSON.stringify(rows, null, 2));
process.exit(fail ? 1 : 0);
