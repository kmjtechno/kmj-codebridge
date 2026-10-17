import { performance } from "node:perf_hooks";
import { planLargePrompt } from "../src/large-prompt-plan.js";

// Run only with synthetic text; never log or benchmark user prompts.
const sizes = [32 * 1024, 256 * 1024, 1024 * 1024];
for (const size of sizes) {
  const paragraph = "# Work item\nKeep requirements and tests.\n";
  const count = Math.floor(size / paragraph.length);
  const prompt = paragraph.repeat(count) + "x".repeat(size - paragraph.length * count);
  const samples = [];
  let outputBytes = 0;
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    const result = planLargePrompt({ prompt });
    samples.push(performance.now() - start);
    outputBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  }
  samples.sort((a, b) => a - b);
  const medianMs = (samples[4] + samples[5]) / 2;
  const p95Ms = samples[9];
  console.log(
    JSON.stringify({
      kind: "synthetic_large_prompt_cpu_benchmark",
      inputBytes: Buffer.byteLength(prompt, "utf8"),
      manifestBytes: outputBytes,
      medianMs: Number(medianMs.toFixed(3)),
      p95Ms: Number(p95Ms.toFixed(3)),
      endToEndChatLatencyMeasured: false,
      modelSpeedMeasured: false,
      storageOrModelCalls: false,
    }),
  );
}
