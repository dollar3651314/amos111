// v6 数据库访问层：统一成 { query(sql, params) → rows, tx(fn) } 两个方法。
// - 生产和测试环境：Supabase Postgres（postgres.js，经 Supabase 连接池，关闭预编译语句）。
// - 本地和自动化测试：内嵌的 Postgres（PGlite），和生产使用同一份建表脚本和 SQL。
// bigint（金额）统一转成 JS 数字：金额单位是 0.000001 USDT，Number 能精确表示到 90 亿 USDT。

const INT8 = 20;

/** 生产：DATABASE_URL 指向 Supabase 的连接池（transaction 模式，端口 6543） */
export async function createPgDb(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, onnotice: () => {},
    types: { bigint: { to: INT8, from: [INT8], serialize: (x) => String(x), parse: (x) => Number(x) } },
  });
  const wrap = (s) => ({ query: async (text, params = []) => [...(await s.unsafe(text, params))] });
  return { ...wrap(sql), tx: (fn) => sql.begin((t) => fn(wrap(t))), end: () => sql.end({ timeout: 5 }) };
}

/** 本地和测试：内嵌 Postgres。dir 为空时只在内存里 */
export async function createLiteDb(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dir || undefined, { parsers: { [INT8]: (v) => Number(v) } });
  const wrap = (s) => ({ query: async (text, params = []) => (await s.query(text, params)).rows });
  // PGlite 只有一个连接：事务串行执行，行锁的语义和生产一致
  return { ...wrap(db), tx: (fn) => db.transaction((t) => fn(wrap(t))), exec: (text) => db.exec(text), end: () => db.close() };
}
