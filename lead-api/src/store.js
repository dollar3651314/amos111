import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 线索存储的统一接口（全部是异步方法）：
//   saveLead(lead)                 保存一条线索
//   saveMailResult(id, ok, error)  记录这条线索的邮件发送结果
//   readAll()                      读出全部记录，补发邮件和导出时使用
// 记录格式与 v1 相同：{"type":"lead", ...} 或 {"type":"mail", ...}

const mailRecord = (id, ok, error) => ({
  type: 'mail', id, ok, ...(error ? { error: String(error).slice(0, 500) } : {}), at: new Date().toISOString(),
});

/** Upstash Redis 版（生产环境使用）：两个只追加的列表，与 v1 的 JSONL 结构一一对应。 */
export function createRedisStore(redis) {
  return {
    saveLead: (lead) => redis.rpush('qc:leads', JSON.stringify({ type: 'lead', ...lead })),
    saveMailResult: (id, ok, error) => redis.rpush('qc:mail', JSON.stringify(mailRecord(id, ok, error))),
    async readAll() {
      const [leads, mails] = await Promise.all([redis.lrange('qc:leads', 0, -1), redis.lrange('qc:mail', 0, -1)]);
      // @upstash/redis 会自动把 JSON 字符串反序列化成对象
      const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
      return [...leads.map(parse), ...mails.map(parse)];
    },
  };
}

/** 文件版（本地开发和端到端测试使用）：追加写入 JSONL 文件，文件权限 600。 */
export function createFileStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'leads.jsonl');
  const append = (record) => appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return {
    file,
    saveLead: async (lead) => append({ type: 'lead', ...lead }),
    saveMailResult: async (id, ok, error) => append(mailRecord(id, ok, error)),
    async readAll() {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

/** 内存版（单元测试使用）。 */
export function createMemoryStore() {
  const records = [];
  return {
    records,
    saveLead: async (lead) => void records.push({ type: 'lead', ...lead }),
    saveMailResult: async (id, ok, error) => void records.push(mailRecord(id, ok, error)),
    readAll: async () => [...records],
  };
}
