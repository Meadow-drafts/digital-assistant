// In-memory append-only sink for tests (failed questions and similar logs).
export function createMemorySink() {
  const records = [];
  return { records, append(record) { records.push(structuredClone(record)); } };
}
