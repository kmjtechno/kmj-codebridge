import { ProjectFiles } from "./policy.js";
import { safeIndexContent } from "./hyperindex.js";

// One bounded, live, policy-checked traversal for several literal queries.
// No cache, index freshness guess, process launch or external dependency.
// This also works on Windows without relaxing persistent-index ACL checks.
export function batchHyperSearch(files, queries, { maxResults = 10 } = {}) {
  if (!(files instanceof ProjectFiles)) throw Error("INDEX_POLICY_REQUIRED");
  if (
    !Array.isArray(queries) ||
    queries.length < 2 ||
    queries.length > 6 ||
    queries.some((q) => typeof q !== "string" || !q || q.length > 200) ||
    new Set(queries).size !== queries.length
  )
    throw Error("INVALID_BATCH_QUERY");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 16)
    throw Error("INVALID_BATCH_SEARCH_LIMIT");

  const results = queries.map((_, queryIndex) => ({
    queryIndex,
    matches: [],
    truncated: false,
  }));
  const coverage = {
    visited: 0,
    filesRead: 0,
    bytes: 0,
    skipped: 0,
    truncated: false,
    scans: 1,
  };
  const allFull = () =>
    results.every((result) => result.matches.length >= maxResults);
  const walk = (dir, depth) => {
    if (depth > 12) {
      coverage.truncated = true;
      return;
    }
    let listing;
    try {
      listing = files.list(dir);
    } catch (error) {
      if (!dir) throw error;
      coverage.skipped++;
      coverage.truncated = true;
      return;
    }
    if (listing.truncated) coverage.truncated = true;
    for (const entry of listing.entries) {
      if (
        coverage.visited >= 2000 ||
        coverage.bytes >= 8 * 1024 * 1024 ||
        allFull()
      ) {
        coverage.truncated = true;
        return;
      }
      coverage.visited++;
      const relative = dir ? dir + "/" + entry.name : entry.name;
      if (entry.type === "directory") {
        walk(relative, depth + 1);
        continue;
      }
      if (entry.type !== "file") continue;
      let file;
      try {
        file = files.read(relative);
      } catch {
        coverage.skipped++;
        coverage.truncated = true;
        continue;
      }
      coverage.filesRead++;
      coverage.bytes += file.bytes;
      if (coverage.bytes > 8 * 1024 * 1024) {
        coverage.truncated = true;
        return;
      }
      const lines = safeIndexContent(file.content).split("\n");
      for (let n = 0; n < lines.length; n++) {
        for (let i = 0; i < queries.length; i++) {
          const row = results[i];
          if (row.matches.length >= maxResults) continue;
          if (lines[n].includes(queries[i])) {
            row.matches.push({
              path: relative,
              line: n + 1,
              text: lines[n].slice(0, 500),
            });
            if (row.matches.length >= maxResults) row.truncated = true;
          }
        }
        if (allFull()) {
          coverage.truncated = true;
          return;
        }
      }
    }
  };
  walk("", 0);
  return {
    adapter: "bounded-live-batch-v1",
    freshness: "live_bounded_scan",
    results: results.map((row) => ({
      ...row,
      truncated: row.truncated || coverage.truncated,
    })),
    coverage,
    truncated:
      coverage.truncated || results.some((result) => result.truncated),
    fallback: false,
    persistentIndexUsed: false,
  };
}
