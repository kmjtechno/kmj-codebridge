import { fail } from "./errors.js";
export async function readJsonLimited(stream, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const raw of stream) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) fail("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("INVALID_JSON");
  }
}
