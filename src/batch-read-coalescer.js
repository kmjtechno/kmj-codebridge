// Coalesce identical, scoped, read-only inputs in one opt-in batch only.
// Never persist results or share them across callers, requests or projects.
const COALESCIBLE = new Set([
  "read_file",
  "read_file_range",
  "read_file_tail",
  "project_file_info",
]);

export function createReadBatchCoalescer(mode) {
  const pending = new Map();
  return async (tool, input, execute) => {
    if ((mode !== "auto" && mode !== "compact") || !COALESCIBLE.has(tool))
      return execute();
    const key = JSON.stringify([tool, input]);
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(execute));
    return pending.get(key);
  };
}
