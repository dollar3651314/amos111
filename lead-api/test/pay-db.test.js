// v6 数据库层：jsonb 读写（BUG-P5）。设置 TEST_DATABASE_URL 时在真实 Postgres（线上的驱动 postgres.js）上运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../src/pay/db.js';
import { migrate, repairDoubleEncoded } from '../src/pay/schema.js';
import { getMeta, setMeta } from '../src/pay/core.js';

test('jsonb：对象、数字、字符串存进去再读出来，类型不变（BUG-P5）', async () => {
  const db = await createTestDb(); await migrate(db);
  await setMeta(db, 'o', { at: '2026-01-01T00:00:00.000Z', n: 1 });
  await setMeta(db, 'n', 123);
  await setMeta(db, 's', 'xpub6abc');
  assert.deepEqual(await getMeta(db, 'o'), { at: '2026-01-01T00:00:00.000Z', n: 1 });
  assert.equal(await getMeta(db, 'n'), 123);
  assert.equal(await getMeta(db, 's'), 'xpub6abc');
  const rows = await db.query(`select key, jsonb_typeof(value) t from pay_meta where key in ('o', 'n', 's') order by key`);
  assert.deepEqual(rows.map((r) => `${r.key}:${r.t}`), ['n:number', 'o:object', 's:string']);
  await db.end();
});

test('jsonb：修复之前多编码了一层的值；正常的字符串不动；只执行一次（BUG-P5）', async () => {
  const db = await createTestDb(); await migrate(db);
  await db.query(`delete from pay_meta where key = 'repair_p5'`);
  await db.query(`insert into pay_meta (key, value) values
    ('a', to_jsonb('{"at":"x"}'::text)), ('b', to_jsonb('123'::text)), ('c', to_jsonb('"xpub6abc"'::text)), ('d', to_jsonb('xpub6abc'::text))`);
  await repairDoubleEncoded(db);
  assert.deepEqual(await getMeta(db, 'a'), { at: 'x' });
  assert.equal(await getMeta(db, 'b'), 123);
  assert.equal(await getMeta(db, 'c'), 'xpub6abc');
  assert.equal(await getMeta(db, 'd'), 'xpub6abc');
  // 标记已写入：再出现类似的值也不会被改
  await db.query(`update pay_meta set value = to_jsonb('456'::text) where key = 'b'`);
  await repairDoubleEncoded(db);
  assert.equal(await getMeta(db, 'b'), '456');
  await db.end();
});
