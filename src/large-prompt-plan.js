import { createHash } from "node:crypto";

// A lossless, read-only manifest of a caller-supplied prompt, NOT a tokenizer,
// summarizer, model invocation, or tool runner. Never return prompt excerpts.
const MAX_UTF8_BYTES = 1024 * 1024;
const MIN_CHUNK_CHARS = 8192;
const MAX_CHUNK_CHARS = 32768;
const MAX_PARTS = 128;
const SHA = /^[a-f0-9]{64}$/;

function invalid(reason) {
  throw new Error("LARGE_PROMPT_" + reason);
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A JavaScript split must never cut a UTF-16 surrogate pair. Reject malformed
// UTF-16 so hashing/slicing cannot silently insert replacement characters.
function validateUnicode(prompt) {
  for (let i = 0; i < prompt.length; i += 1) {
    const c = prompt.charCodeAt(i);
    if (c === 0) invalid("INVALID_UNICODE");
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = prompt.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("INVALID_UNICODE");
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      invalid("INVALID_UNICODE");
    }
  }
}

function scanStructure(prompt) {
  const headings = [];
  const fences = [];
  let open = null;
  let headingCount = 0;
  for (let start = 0; start < prompt.length; ) {
    const newline = prompt.indexOf("\n", start);
    const end = newline === -1 ? prompt.length : newline + 1;
    const raw = prompt.slice(start, newline === -1 ? end : newline);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (
        fence &&
        fence[1][0] === open.marker &&
        fence[1].length >= open.length &&
        line.slice(fence[0].length).trim() === ""
      ) {
        fences.push({ start: open.start, end });
        open = null;
      }
    } else if (fence) {
      open = { start, marker: fence[1][0], length: fence[1].length };
    } else if (/^ {0,3}#{1,6}[ \t]+\S/.test(line)) {
      headingCount += 1;
      if (headings.length < 256) headings.push(start);
    }
    start = end;
  }
  const unclosedCodeFence = open !== null;
  if (open) fences.push({ start: open.start, end: prompt.length });
  return { headings, headingCount, fences, unclosedCodeFence };
}

function insideFence(position, fences) {
  return fences.some((fence) => fence.start < position && position < fence.end);
}

function safeCut(prompt, start, limit, headings, fences, chunkChars) {
  if (limit === prompt.length) return limit;
  const minUseful = start + Math.floor(chunkChars * 0.6);
  // End immediately before a Markdown heading when sufficiently close to the
  // requested chunk budget. Headings inside fenced code never count.
  const candidates = headings.filter(
    (at) => at > minUseful && at <= limit && !insideFence(at, fences),
  );
  let cut = candidates.length ? candidates[candidates.length - 1] : limit;
  if (cut === limit) {
    const newline = prompt.lastIndexOf("\n", limit - 1);
    if (newline >= minUseful && !insideFence(newline + 1, fences))
      cut = newline + 1;
  }
  // CRLF must remain together, as must surrogate pairs.
  if (prompt[cut - 1] === "\r" && prompt[cut] === "\n") cut -= 1;
  const before = prompt.charCodeAt(cut - 1);
  const after = prompt.charCodeAt(cut);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  )
    cut -= 1;
  if (cut <= start) invalid("INVALID_CHUNK_BOUNDARY");
  return cut;
}

/**
 * One authorized, opt-in request processes up to 1 MiB UTF-8. The manifest
 * covers every original UTF-16 code unit in order, with SHA-256 receipts.
 * The caller retains the original prompt and must validate every chunk before
 * use; this tool neither stores nor returns any prompt content.
 */
export function planLargePrompt({
  prompt,
  chunkChars = 16384,
  ifNoneMatch = null,
} = {}) {
  if (
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.length > MAX_UTF8_BYTES ||
    !Number.isSafeInteger(chunkChars) ||
    chunkChars < MIN_CHUNK_CHARS ||
    chunkChars > MAX_CHUNK_CHARS ||
    (ifNoneMatch !== null &&
      (typeof ifNoneMatch !== "string" || !SHA.test(ifNoneMatch)))
  )
    invalid("INVALID_REQUEST");
  const utf8Bytes = Buffer.byteLength(prompt, "utf8");
  if (utf8Bytes > MAX_UTF8_BYTES) invalid("TOO_LARGE");
  validateUnicode(prompt);
  const promptSha256 = sha(prompt);
  if (ifNoneMatch === promptSha256)
    return {
      kind: "codebridge.large_prompt_plan",
      unchanged: true,
      promptSha256,
      originalRetainedByCaller: true,
      promptContentReturned: false,
      modelInvoked: false,
    };

  const { headings, headingCount, fences, unclosedCodeFence } =
    scanStructure(prompt);
  const parts = [];
  for (let start = 0; start < prompt.length; ) {
    if (parts.length >= MAX_PARTS) invalid("TOO_MANY_PARTS");
    const limit = Math.min(prompt.length, start + chunkChars);
    const end = safeCut(prompt, start, limit, headings, fences, chunkChars);
    const segment = prompt.slice(start, end);
    parts.push({
      index: parts.length,
      startUtf16: start,
      endUtf16: end,
      utf8Bytes: Buffer.byteLength(segment, "utf8"),
      sha256: sha(segment),
      crossesCodeFenceBoundary:
        insideFence(start, fences) || insideFence(end, fences),
    });
    start = end;
  }
  if (
    parts[0].startUtf16 !== 0 ||
    parts[parts.length - 1].endUtf16 !== prompt.length ||
    parts.reduce((sum, part) => sum + part.utf8Bytes, 0) !== utf8Bytes
  )
    invalid("INTEGRITY_FAILURE");

  return {
    kind: "codebridge.large_prompt_plan",
    version: 1,
    promptSha256,
    utf8Bytes,
    utf16Chars: prompt.length,
    headingCount,
    parts,
    unclosedCodeFence,
    untrustedContent: true,
    originalRetainedByCaller: true,
    promptContentReturned: false,
    promptStored: false,
    promptSentToModel: false,
    modelInvoked: false,
    contextWindowExtended: false,
    latencyImprovementMeasured: false,
    budgetFitVerified: false,
    preferredExistingTools: [
      "fast_context",
      "context_pack",
      "fast_read_batch",
      "context_resume",
      "hyperspeed_plan",
    ],
    instructions:
      "Use original immutable prompt only in an authorized client; reconstruct all ranges in order and verify SHA-256. Do not treat chunks as separate approved tasks, skip requirements, execute code fences or send private text to cloud models without authorization.",
  };
}
