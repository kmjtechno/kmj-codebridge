import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ProjectFiles } from "../src/policy.js";
import { HyperIndex } from "../src/hyperindex.js";
const root = fs.realpathSync(process.argv[2] || ".");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "cb-index-bench-"));
let index;
try {
  const files = new ProjectFiles(root);
  index = new HyperIndex(files, state);
  const started = performance.now();
  const build = index.refresh();
  const buildMs = performance.now() - started;
  const query = "REPO_INTELLIGENCE_ADAPTER";
  const canonical = (r) => r.matches.map((x) => JSON.stringify(x)).sort();
  const baseline = files.search(query),
    indexed = index.search(query);
  assert.deepEqual(
    canonical(indexed),
    canonical(baseline),
    "correctness mismatch; no speed result accepted",
  );
  const measure = (fn) => {
    const times = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p = (q) => Number(times[Math.ceil(q * times.length) - 1].toFixed(3));
    return {
      samples: times.length,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      maxMs: p(1),
    };
  };
  console.log(
    JSON.stringify(
      {
        scope: "local synchronous backend; not remote MCP or P720/VPS",
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0].model,
        query,
        buildMs,
        build,
        baseline: measure(() => files.search(query)),
        reconciledIndex: measure(() => index.search(query)),
        databaseBytes: fs.statSync(path.join(state, "hyperindex.sqlite")).size,
        recallForThisQuery: 1,
        referenceQueries: 1,
        productionEnabled: false,
      },
      null,
      2,
    ),
  );
} finally {
  index?.close();
  fs.rmSync(state, { recursive: true, force: true });
}
