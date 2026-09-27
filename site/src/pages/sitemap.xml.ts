import type { APIRoute } from 'astro';
import { PAGES, href, type PageKey } from '../lib/i18n';

// 生成带中英互指标注（hreflang）的 sitemap
export const GET: APIRoute = ({ site }) => {
  const abs = (p: string) => new URL(p, site).href;
  const urls = (Object.keys(PAGES) as PageKey[]).flatMap((page) =>
    (['en', 'zh'] as const).map(
      (lang) => `  <url>
    <loc>${abs(href(lang, page))}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${abs(href('en', page))}"/>
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${abs(href('zh', page))}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${abs(href('en', page))}"/>
  </url>`,
    ),
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml' } });
};
