import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createWhisperfileLocalBackend } from "../src/whisperfile-backend.js";

async function serverFor(t, handler) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    hits.push({ method: req.method, path: req.url });
    await handler(req, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { port: server.address().port, hits };
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function wav() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

test("whisperfile disabled by default; zero network or audio processing", async (t) => {
  const { port, hits } = await serverFor(t, (_req, res) =>
    json(res, { status: "ok" }),
  );
  const local = createWhisperfileLocalBackend({ port });
  const state = await local.status();
  assert.equal(state.available, false);
  assert.equal(state.modelExecution, "NOT_EXECUTED");
  await assert.rejects(
    local.transcribe({ audioBuffer: wav(), localProcessingApproved: true }),
    /WHISPERFILE_NOT_ENABLED/,
  );
  assert.deepEqual(hits, []);
});

test("readiness is local, GET /health only, not an identity attestation", async (t) => {
  const { port, hits } = await serverFor(t, (_req, res) =>
    json(res, { status: "ok" }),
  );
  const local = createWhisperfileLocalBackend({ enabled: true, port });
  const state = await local.status();
  assert.equal(state.available, true);
  assert.equal(state.backendIdentityVerified, false);
  assert.deepEqual(hits, [{ method: "GET", path: "/health" }]);
});

test("approved WAV bytes only, multipart inference, untrusted transcript", async (t) => {
  let body = Buffer.alloc(0);
  const { port, hits } = await serverFor(t, (req, res) => {
    assert.equal(req.url, "/inference");
    assert.equal(req.method, "POST");
    assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=kmj-/);
    const received = [];
    req.on("data", (chunk) => received.push(chunk));
    req.on("end", () => {
      body = Buffer.concat(received);
      json(res, { text: " नमस्ते KMJ" });
    });
  });
  const local = createWhisperfileLocalBackend({ enabled: true, port });
  await assert.rejects(
    local.transcribe({ audioBuffer: wav() }),
    /WHISPERFILE_APPROVAL_REQUIRED/,
  );
  assert.deepEqual(hits, []);
  const result = await local.transcribe({
    audioBuffer: wav(),
    localProcessingApproved: true,
    language: "hi",
  });
  assert.equal(result.text, " नमस्ते KMJ");
  assert.equal(result.modelExecution, "LOCAL_BACKEND_RESPONDED");
  assert.equal(result.backendIdentityVerified, false);
  assert.equal(result.cloudFallbackByAdapter, false);
  assert.equal(result.outputIsUntrusted, true);
  assert.equal(result.audioNotPersistedByAdapter, true);
  assert.match(body.toString("latin1"), /name="language"\r\n\r\nhi/);
  assert.match(body.toString("latin1"), /filename="clip.wav"/);
  assert.deepEqual(hits, [{ method: "POST", path: "/inference" }]);
});

test("invalid local ports, WAV, language, audio budgets fail before network", async (t) => {
  assert.throws(
    () => createWhisperfileLocalBackend({ enabled: true, port: 0 }),
    /WHISPERFILE_CONFIG_INVALID/,
  );
  assert.throws(
    () => createWhisperfileLocalBackend({ enabled: 1 }),
    /WHISPERFILE_CONFIG_INVALID/,
  );
  const { port, hits } = await serverFor(t, (_req, res) =>
    json(res, { text: "should not run" }),
  );
  const backend = createWhisperfileLocalBackend({ enabled: true, port });
  for (const bad of [
    { audioBuffer: Buffer.from("not WAV") },
    { audioBuffer: wav(), language: "../secret" },
    { audioBuffer: wav(), language: "EN_us" },
    { audioBuffer: wav(), timeoutSeconds: 120 },
    { audioBuffer: Buffer.alloc(1_048_577) },
    { audioBuffer: "c:\\private\\audio.wav" },
  ]) {
    await assert.rejects(
      backend.transcribe({ ...bad, localProcessingApproved: true }),
      /WHISPERFILE_REQUEST_INVALID/,
    );
  }
  assert.deepEqual(hits, []);
});

test("refuses redirect and invalid transcriptions without external calls", async (t) => {
  const { port, hits } = await serverFor(t, (_req, res) => {
    res.writeHead(302, { location: "https://external.invalid/upload" });
    res.end();
  });
  const backend = createWhisperfileLocalBackend({ enabled: true, port });
  assert.equal((await backend.status()).available, false);
  await assert.rejects(
    backend.transcribe({ audioBuffer: wav(), localProcessingApproved: true }),
    /WHISPERFILE_BACKEND_UNAVAILABLE_OR_INVALID/,
  );
  assert.equal(hits.length, 2);

  const { port: invalidPort } = await serverFor(t, (_req, res) =>
    json(res, { text: "" }),
  );
  const invalidBackend = createWhisperfileLocalBackend({
    enabled: true,
    port: invalidPort,
  });
  await assert.rejects(
    invalidBackend.transcribe({
      audioBuffer: wav(),
      localProcessingApproved: true,
    }),
    /WHISPERFILE_TRANSCRIPT_INVALID/,
  );
});

test("one local transcription in flight, lease releases safely", async (t) => {
  let signalStarted;
  let finish;
  const started = new Promise((done) => { signalStarted = done; });
  const gate = new Promise((done) => { finish = done; });
  const { port } = await serverFor(t, async (req, res) => {
    for await (const _chunk of req) {}
    signalStarted();
    await gate;
    json(res, { text: "ready" });
  });
  const backend = createWhisperfileLocalBackend({ enabled: true, port });
  const args = { audioBuffer: wav(), localProcessingApproved: true };
  const first = backend.transcribe(args);
  await started;
  await assert.rejects(backend.transcribe(args), /WHISPERFILE_BUSY/);
  finish();
  assert.equal((await first).text, "ready");
});
