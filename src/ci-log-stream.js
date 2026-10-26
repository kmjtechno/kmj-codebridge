import { sanitizeCiLog } from "./ci-triage.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LINE = 400;
const MAX_DIAGNOSTICS = 18;

// Read once, retain only sanitized complete diagnostic lines. No raw log
// cache, disk write, external LLM, retry or unbounded response allocation.
export async function readCiLogDiagnostics(stream) {
  const decoder = new TextDecoder("utf-8");
  const lines = [];
  let pending = "";
  let dropping = false;
  let privateKey = false;
  let markerWindow = "";
  let delimiter = null;
  let markerLine = false;
  let truncated = false;
  let sourceComplete = true;
  let sourceBytesRead = 0;
  const accept = () => {
    if (!dropping && !markerLine && !privateKey) {
      for (const line of sanitizeCiLog(pending).lines) {
        const previous = lines.indexOf(line);
        if (previous !== -1) lines.splice(previous, 1);
        lines.push(line);
        if (lines.length > MAX_DIAGNOSTICS) {
          lines.shift();
          truncated = true;
        }
      }
    }
    pending = "";
    dropping = false;
    markerWindow = "";
    delimiter = null;
    markerLine = false;
  };
  const consume = (text) => {
    for (const character of text) {
      if (character === "\n") accept();
      else {
        // Recognize key delimiters even after a line exceeds retention.
        // This holds at most 32 marker characters, never the discarded line.
        if (markerWindow || character === "-") {
          markerWindow = (markerWindow + character).slice(-32);
          if (markerWindow.endsWith("-----BEGIN ")) delimiter = "begin";
          if (markerWindow.endsWith("-----END ")) delimiter = "end";
          if (delimiter && markerWindow.endsWith("PRIVATE KEY-----")) {
            privateKey = delimiter === "begin";
            markerLine = true;
            delimiter = null;
          }
          if (!delimiter && !markerWindow.includes("-")) markerWindow = "";
        }
        if (!dropping) {
          pending += character;
          if (pending.length > MAX_LINE) {
            pending = "";
            dropping = true;
            truncated = true;
          }
        }
      }
    }
  };
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const available = Math.min(chunk.length, MAX_BYTES - sourceBytesRead);
    // Keep decoder allocations bounded even for a single huge input chunk.
    for (let offset = 0; offset < available; offset += 16384)
      consume(
        decoder.decode(
          chunk.subarray(offset, Math.min(available, offset + 16384)),
          { stream: true },
        ),
      );
    sourceBytesRead += available;
    if (available < chunk.length) {
      sourceComplete = false;
      truncated = true;
      break; // for-await closes/cancels the response stream.
    }
  }
  if (sourceComplete) {
    consume(decoder.decode());
    if (pending || dropping) accept();
  }
  // At a byte limit the unfinished line is never treated as a diagnostic.
  return { lines, truncated, sourceComplete, sourceBytesRead };
}
