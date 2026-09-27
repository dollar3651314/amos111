import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 线索采用追加写入的 JSONL 文件存储，文件权限 600。
// 一行一条记录，有两种类型：
//   {"type":"lead", ...}  一条线索
//   {"type":"mail", ...}  该线索的邮件发送结果
export function createFileStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'leads.jsonl');
  const append = (record) => appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });

  return {
    file,
    saveLead: (lead) => append({ type: 'lead', ...lead }),
    saveMailResult: (id, ok, error) =>
      append({ type: 'mail', id, ok, ...(error ? { error: String(error).slice(0, 500) } : {}), at: new Date().toISOString() }),
    readAll() {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
  };
}
