import http from "node:http";
import { randomBytes } from "node:crypto";

// Source-only whisperfile connector for future KMJ Kristi voice input.
// Never captures a microphone, loads a file, starts a runtime or invokes MCP.
// It can only POST caller-approved bounded WAV bytes to fixed local endpoints.
const MAX_AUDIO_BYTES = 1_048_576;
const MAX_REPLY_BYTES = 16_384;
const MAX_TEXT_CHARS = 4_096;
const LANG = /^(?:auto|[a-z]{2})$/;

function invalid(code) {
  throw new Error("WHISPERFILE_" + code);
}

function request(port, endpoint, { body, contentType, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method: body ? "POST" : "GET",
        timeout: timeoutMs,
        headers: body
          ? {
              accept: "application/json",
              "content-type": contentType,
              "content-length": body.length,
            }
          : { accept: "application/json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("WHISPERFILE_HTTP_NOT_OK"));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            req.destroy(new Error("WHISPERFILE_REPLY_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("WHISPERFILE_REPLY_INVALID"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("WHISPERFILE_TIMEOUT")));
    req.on("error", reject);
    req.end(body);
  });
}

function wavRequest(audioBuffer, language) {
  const boundary = "kmj-" + randomBytes(16).toString("hex");
  const start = Buffer.from(
    "--" +
      boundary +
      '\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n' +
      "--" +
      boundary +
      '\r\nContent-Disposition: form-data; name="language"\r\n\r\n' +
      language +
      "\r\n--" +
      boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n' +
      "Content-Type: audio/wav\r\n\r\n",
    "utf8",
  );
  const end = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
  return {
    body: Buffer.concat([start, audioBuffer, end]),
    contentType: "multipart/form-data; boundary=" + boundary,
  };
}

export function createWhisperfileLocalBackend({
  enabled = false,
  port = 8081,
} = {}) {
  // Owner-local configuration only: never bind a user/MCP-controlled port.
  if (
    typeof enabled !== "boolean" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    invalid("CONFIG_INVALID");
  let busy = false;
  return {
    async status() {
      if (!enabled)
        return {
          enabled: false,
          available: false,
          modelExecution: "NOT_EXECUTED",
          reason: "WHISPERFILE_NOT_ENABLED",
        };
      try {
        const health = await request(port, "/health", { timeoutMs: 1800 });
        return {
          enabled: true,
          available: health?.status === "ok",
          activeRequest: busy,
          transport: "LOCAL_LOOPBACK_ONLY",
          backendIdentityVerified: false,
          modelExecution: "NOT_EXECUTED",
        };
      } catch {
        return {
          enabled: true,
          available: false,
          activeRequest: busy,
          reason: "WHISPERFILE_BACKEND_UNAVAILABLE",
          modelExecution: "NOT_EXECUTED",
        };
      }
    },
    async transcribe({
      audioBuffer,
      language = "auto",
      localProcessingApproved = false,
      timeoutSeconds = 30,
    } = {}) {
      if (!enabled) invalid("NOT_ENABLED");
      if (localProcessingApproved !== true) invalid("APPROVAL_REQUIRED");
      if (
        !Buffer.isBuffer(audioBuffer) ||
        audioBuffer.length < 44 ||
        audioBuffer.length > MAX_AUDIO_BYTES ||
        audioBuffer.toString("ascii", 0, 4) !== "RIFF" ||
        audioBuffer.toString("ascii", 8, 12) !== "WAVE" ||
        typeof language !== "string" ||
        !LANG.test(language) ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 5 ||
        timeoutSeconds > 60
      )
        invalid("REQUEST_INVALID");
      if (busy) invalid("BUSY");
      busy = true;
      try {
        const { body, contentType } = wavRequest(audioBuffer, language);
        let reply;
        try {
          reply = await request(port, "/inference", {
            body,
            contentType,
            timeoutMs: timeoutSeconds * 1000,
          });
        } catch {
          invalid("BACKEND_UNAVAILABLE_OR_INVALID");
        }
        if (
          typeof reply?.text !== "string" ||
          reply.text.trim().length === 0 ||
          reply.text.length > MAX_TEXT_CHARS
        )
          invalid("TRANSCRIPT_INVALID");
        return {
          text: reply.text,
          provider: "whisperfile-loopback",
          transport: "LOCAL_LOOPBACK_ONLY",
          modelExecution: "LOCAL_BACKEND_RESPONDED",
          backendIdentityVerified: false,
          cloudFallbackByAdapter: false,
          outputIsUntrusted: true,
          audioNotPersistedByAdapter: true,
        };
      } finally {
        busy = false;
      }
    },
  };
}
