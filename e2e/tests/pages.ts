// 测试用的页面清单：8 类页面，每类都有中英两版
export const SLUGS = ['', 'solutions/', 'how-it-works/', 'security/', 'about/', 'contact/', 'privacy/', 'terms/'];
export const PAGES = SLUGS.flatMap((s) => [
  { lang: 'en', path: '/' + s, other: '/zh/' + s },
  { lang: 'zh', path: '/zh/' + s, other: '/' + s },
]);
