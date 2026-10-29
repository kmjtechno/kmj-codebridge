// Bounded tail reader for GitHub Actions job logs. The final lines of a log
// carry the failure, so a log larger than the response budget must return its
// tail instead of failing with BODY_TOO_LARGE. Streams once; keeps at most
// `keepBytes` of complete lines; never buffers the whole log; drops PEM
// private-key blocks even when their BEGIN line is outside the kept window.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export async function readLogTail(
  stream,
  { keepBytes = 65536, maxReadBytes = 16 * 1024 * 1024 } = {},
) {
  const decoder = new TextDecoder("utf-8");
  const kept = [];
  let keptBytes = 0;
  let pending = "";
  let inPem = false;
  let droppedLines = 0;
  let bytesRead = 0;
  let sourceComplete = true;
  const push = (line) => {
    if (inPem) {
      if (PEM_END.test(line)) inPem = false;
      return;
    }
    if (PEM_BEGIN.test(line)) {
      inPem = !PEM_END.test(line);
      line = "[REDACTED PRIVATE KEY]";
    }
    const size = Buffer.byteLength(line) + 1;
    if (size > keepBytes) line = line.slice(0, 2000) + " [line truncated]";
    kept.push(line);
    keptBytes += Buffer.byteLength(line) + 1;
    while (keptBytes > keepBytes && kept.length > 1) {
      keptBytes -= Buffer.byteLength(kept.shift()) + 1;
      droppedLines++;
    }
  };
  const consume = (text) => {
    pending += text;
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      push(pending.slice(0, index).replace(/\r$/, ""));
      pending = pending.slice(index + 1);
    }
    // A pathological single line without newlines must not grow unbounded.
    if (pending.length > keepBytes) {
      push(pending.slice(0, 2000) + " [line truncated]");
      pending = "";
    }
  };
  for await (const raw of stream) {
    const chunk = Buffer.from(raw);
    bytesRead += chunk.length;
    if (bytesRead > maxReadBytes) {
      sourceComplete = false;
      break;
    }
    consume(decoder.decode(chunk, { stream: true }));
  }
  if (sourceComplete) consume(decoder.decode());
  if (pending) push(pending);
  return {
    text: kept.join("\n"),
    truncated: droppedLines > 0 || !sourceComplete,
    tail: droppedLines > 0,
    droppedLines,
    sourceComplete,
  };
}
