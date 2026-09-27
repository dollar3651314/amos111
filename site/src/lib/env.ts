/**
 * 是否构建为"高保真原型"：Vercel 预览环境（VERCEL_ENV=preview）自动开启，本地可以用 PROTOTYPE=1 开启。
 * 原型模式下：页面顶部显示"这是原型"的标识；表单提交返回模拟结果，不调用后端，也不发送任何数据。
 * 生产环境（VERCEL_ENV=production）和测试构建都不会开启。
 */
export const IS_PROTOTYPE = process.env.VERCEL_ENV === 'preview' || process.env.PROTOTYPE === '1';
