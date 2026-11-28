// Bounded Debug Adapter Protocol transport for a trusted, local stdio adapter.
// This is not an MCP route, debugger launcher, process-attach grant or sandbox.
// Raw adapter responses are internal and must not be forwarded to a chat.
import { TextDecoder } from "node:util";

const MAX_BODY = 256 * 1024;
const MAX_HEADER = 1024;
const MAX_PENDING = 16;
const MAX_EVENTS = 32;
const DELIMITER = Buffer.from("\r\n\r\n");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const COMMANDS = new Set([
  "initialize",
  "launch",
  "setBreakpoints",
  "configurationDone",
  "threads",
  "stackTrace",
  "scopes",
  "variables",
  "next",
  "stepIn",
  "stepOut",
  "continue",
  "pause",
  "disconnect",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeDapRequest(seq, command, args = {}) {
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !COMMANDS.has(command) ||
    !record(args)
  )
    throw Error("DAP_REQUEST_INVALID");
  const body = Buffer.from(
    JSON.stringify({ seq, type: "request", command, arguments: args }),
    "utf8",
  );
  if (body.length > MAX_BODY) throw Error("DAP_FRAME_TOO_LARGE");
  return Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\r\n\r\n"),
    body,
  ]);
}

export class DapFrameDecoder {
  #buffer = Buffer.alloc(0);
  #length = null;
  #failed = false;

  push(chunk) {
    if (this.#failed) throw Error("DAP_DECODER_CLOSED");
    try {
      if (!Buffer.isBuffer(chunk)) throw Error("DAP_CHUNK_INVALID");
      if (this.#buffer.length + chunk.length > MAX_BODY + MAX_HEADER)
        throw Error("DAP_BUFFER_LIMIT");
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      const messages = [];
      while (this.#buffer.length) {
        if (this.#length === null) {
          const end = this.#buffer.indexOf(DELIMITER);
          if (end < 0) {
            if (this.#buffer.length > MAX_HEADER)
              throw Error("DAP_HEADER_LIMIT");
            break;
          }
          if (end > MAX_HEADER) throw Error("DAP_HEADER_LIMIT");
          const header = this.#buffer.subarray(0, end).toString("latin1");
          const match = /^Content-Length: ([1-9][0-9]{0,6})$/i.exec(header);
          if (!match) throw Error("DAP_HEADER_INVALID");
          this.#length = Number(match[1]);
          if (this.#length > MAX_BODY) throw Error("DAP_FRAME_TOO_LARGE");
          this.#buffer = this.#buffer.subarray(end + DELIMITER.length);
        }
        if (this.#buffer.length < this.#length) break;
        const value = JSON.parse(
          utf8.decode(this.#buffer.subarray(0, this.#length)),
        );
        if (!record(value)) throw Error("DAP_MESSAGE_INVALID");
        this.#buffer = this.#buffer.subarray(this.#length);
        this.#length = null;
        messages.push(value);
        if (messages.length > 64) throw Error("DAP_FRAME_BATCH_LIMIT");
      }
      return messages;
    } catch {
      this.#failed = true;
      this.#buffer = Buffer.alloc(0);
      throw Error("DAP_PROTOCOL_INVALID");
    }
  }
}

// The trusted caller owns adapter lifecycle and passes a dedicated stdio
// transport. No process command, host path or executable is accepted here.
// The caller must close the adapter on any transport failure.
export function createDapConnection({
  write,
  closeTransport,
  timeoutMs = 5000,
}) {
  if (
    typeof write !== "function" ||
    typeof closeTransport !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  )
    throw Error("DAP_TRANSPORT_INVALID");
  const decoder = new DapFrameDecoder();
  const pending = new Map();
  const events = [];
  let seq = 0;
  let closed = false;
  let eventOverflow = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error("DAP_CONNECTION_CLOSED"));
    }
    pending.clear();
    events.length = 0;
    closeTransport();
  };
  function receive(chunk) {
    if (closed) return;
    try {
      for (const message of decoder.push(chunk)) {
        if (message.type === "response") {
          const entry = pending.get(message.request_seq);
          if (
            !entry ||
            entry.command !== message.command ||
            typeof message.success !== "boolean"
          )
            throw Error("DAP_RESPONSE_UNCORRELATED");
          pending.delete(message.request_seq);
          clearTimeout(entry.timer);
          if (message.success) entry.resolve(message.body ?? null);
          else entry.reject(Error("DAP_REQUEST_FAILED"));
        } else if (
          message.type === "event" &&
          typeof message.event === "string" &&
          /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(message.event)
        ) {
          // Never retain raw output, process paths or variables from events.
          // Stopped/thread events are retained as metadata only; lost events
          // must be treated as a degraded debugger session.
          if (events.length >= MAX_EVENTS) {
            eventOverflow = true;
            events.shift();
          }
          events.push({ event: message.event });
        } else {
          // Reverse requests (e.g. runInTerminal) are never executed.
          throw Error("DAP_MESSAGE_UNSUPPORTED");
        }
      }
    } catch {
      close();
      throw Error("DAP_CONNECTION_PROTOCOL_FAILURE");
    }
  }

  function request(command, args = {}) {
    if (closed) return Promise.reject(Error("DAP_CONNECTION_CLOSED"));
    if (pending.size >= MAX_PENDING)
      return Promise.reject(Error("DAP_PENDING_LIMIT"));
    const id = ++seq;
    let frame;
    try {
      frame = encodeDapRequest(id, command, args);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout makes state-changing debugger commands ambiguous.
        // Close rather than silently resend a step/continue/launch request.
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(Error("DAP_REQUEST_TIMEOUT"));
        close();
      }, timeoutMs);
      pending.set(id, { command, resolve, reject, timer });
      try {
        write(frame);
      } catch {
        close();
      }
    });
  }

  return Object.freeze({
    request,
    receive,
    close,
    status() {
      return { closed, pending: pending.size, eventOverflow };
    },
    drainEvents() {
      return { events: events.splice(0), eventOverflow };
    },
  });
}
