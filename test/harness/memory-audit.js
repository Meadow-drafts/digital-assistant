// In-memory audit sink for tests, same interface as the real one (append, all, purge).
export function createMemoryAudit() {
  const records = [];
  return {
    records,
    append(record) { records.push(structuredClone(record)); },
    all: () => structuredClone(records),
    purge(beforeMs) {
      const keep = records.filter((r) => Date.parse(r.time) >= beforeMs);
      const removed = records.length - keep.length;
      records.splice(0, records.length, ...keep);
      return removed;
    },
  };
}
