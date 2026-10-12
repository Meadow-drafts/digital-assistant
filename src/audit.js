import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Append-only JSONL audit log. Opened with the append flag only; nothing in the
// service reads, rewrites or truncates it.
export function createFileAudit(path) {
  let ready;
  return {
    async append(record) {
      ready ??= mkdir(dirname(path), { recursive: true });
      await ready;
      await appendFile(path, `${JSON.stringify(record)}\n`, { flag: 'a' });
    },
  };
}
