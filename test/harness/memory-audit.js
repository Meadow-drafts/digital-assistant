// In-memory audit sink for tests, same interface as the real one.
export function createMemoryAudit() {
  const records = [];
  return { records, append(record) { records.push(structuredClone(record)); } };
}
