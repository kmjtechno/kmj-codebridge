import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

const RESOURCE = "https://kmjtechno.com/mcp";
const ORIGIN = "https://kmjtechno.com";
const SCOPES = "codebridge:read codebridge:write codebridge:execute";
const DATA_DIR =
  process.env.PLUGIN_DATA || path.join(os.homedir(), ".kmj-codebridge");
const TOKEN_FILE = path.join(DATA_DIR, "desktop-oauth.json");
const VERSION = "0.2.3";
let cachedTools = null;
let cachedToolsAt = 0;
let authInFlight = null;

function log(message) {
  process.stderr.write(`[KMJ CodeBridge] ${message}\n`);
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureDataDir();
  const tmp = `${TOKEN_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  try {
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch {}
}

function clearState() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "error",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).origin}`);
  }
  if (!response.ok) {
    const message =
      body?.error_description ||
      body?.error?.message ||
      body?.error ||
      `HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function oauthMetadata() {
  const protectedMeta = await fetchJson(
    `${ORIGIN}/.well-known/oauth-protected-resource`,
  );
  const issuer = Array.isArray(protectedMeta.authorization_servers)
    ? protectedMeta.authorization_servers[0]
    : ORIGIN;
  if (typeof issuer !== "string" || !issuer.startsWith("https://"))
    throw new Error("KMJ OAuth issuer is unavailable");
  const authMeta = await fetchJson(
    new URL("/.well-known/oauth-authorization-server", issuer).toString(),
  );
  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ]) {
    if (
      typeof authMeta[field] !== "string" ||
      !authMeta[field].startsWith("https://")
    )
      throw new Error(`KMJ OAuth metadata is missing ${field}`);
  }
  return authMeta;
}

function openBrowser(url) {
  let child;
  if (process.platform === "win32") {
    child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  }
  child.on("error", (error) =>
    log(`Could not open browser automatically: ${error.message}`),
  );
  child.unref();
}

function listenForCallback() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const payload = {
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
        error_description: url.searchParams.get("error_description"),
      };
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        "<!doctype html><meta charset=utf-8><title>KMJ CodeBridge connected</title><style>body{font-family:system-ui;background:#0b0b0b;color:#fff;padding:48px}b{color:#ff2b35}</style><h1><b>KMJ CodeBridge</b> connected</h1><p>Authorization complete. You can close this tab and return to ChatGPT.</p>",
      );
      if (!settled) {
        settled = true;
        resolve(payload);
        setTimeout(() => server.close(), 100);
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve.listener = server;
      resolve.port = address.port;
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("KMJ OAuth authorization timed out"));
      }
    }, 180000).unref();
    // expose listener after it is bound via a side promise below
    listenForCallback.lastServer = server;
  });
}

async function createCallbackWaiter() {
  let resolvePayload, rejectPayload;
  const payload = new Promise((resolve, reject) => {
    resolvePayload = resolve;
    rejectPayload = reject;
  });
  let settled = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const result = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      error_description: url.searchParams.get("error_description"),
    };
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(
      "<!doctype html><meta charset=utf-8><title>KMJ CodeBridge connected</title><style>body{font-family:system-ui;background:#0b0b0b;color:#fff;padding:48px}b{color:#ff2b35}</style><h1><b>KMJ CodeBridge</b> connected</h1><p>Authorization complete. You can close this tab and return to ChatGPT.</p>",
    );
    if (!settled) {
      settled = true;
      resolvePayload(result);
      setTimeout(() => server.close(), 100);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      server.close();
      rejectPayload(new Error("KMJ OAuth authorization timed out"));
    }
  }, 180000);
  timer.unref();
  payload.finally(() => clearTimeout(timer));
  return { port, payload, close: () => server.close() };
}

async function interactiveAuthorize() {
  if (authInFlight) return authInFlight;
  authInFlight = (async () => {
    const meta = await oauthMetadata();
    const callback = await createCallbackWaiter();
    try {
      const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
      const registration = await fetchJson(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "KMJ CodeBridge Desktop",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      if (typeof registration.client_id !== "string")
        throw new Error("KMJ OAuth registration did not return a client ID");

      const verifier = base64url(randomBytes(48));
      const challenge = base64url(
        createHash("sha256").update(verifier).digest(),
      );
      const state = base64url(randomBytes(24));
      const authorize = new URL(meta.authorization_endpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", registration.client_id);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("scope", SCOPES);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("resource", RESOURCE);

      log("Opening KMJ OAuth in the default browser");
      openBrowser(authorize.toString());
      const result = await callback.payload;
      if (result.error)
        throw new Error(result.error_description || result.error);
      if (!result.code || result.state !== state)
        throw new Error("KMJ OAuth callback validation failed");

      const token = await fetchJson(meta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: result.code,
          client_id: registration.client_id,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      });
      const now = Date.now();
      const stored = {
        client_id: registration.client_id,
        access_token: token.access_token,
        refresh_token: token.refresh_token || null,
        token_type: token.token_type || "Bearer",
        scope: token.scope || SCOPES,
        expires_at: now + Number(token.expires_in || 3600) * 1000,
        issuer: meta.issuer || ORIGIN,
        token_endpoint: meta.token_endpoint,
        connected_at: new Date(now).toISOString(),
      };
      if (typeof stored.access_token !== "string" || !stored.access_token)
        throw new Error(
          "KMJ OAuth token response did not include an access token",
        );
      writeState(stored);
      return stored;
    } finally {
      callback.close();
    }
  })();
  try {
    return await authInFlight;
  } finally {
    authInFlight = null;
  }
}

async function refreshToken(state) {
  if (!state.refresh_token || !state.client_id) return null;
  const meta = await oauthMetadata();
  try {
    const token = await fetchJson(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh_token,
        client_id: state.client_id,
        resource: RESOURCE,
      }),
    });
    const refreshed = {
      ...state,
      access_token: token.access_token,
      refresh_token: token.refresh_token || state.refresh_token,
      token_type: token.token_type || "Bearer",
      scope: token.scope || state.scope || SCOPES,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
      token_endpoint: meta.token_endpoint,
    };
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token)
      return null;
    writeState(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

async function ensureToken(forceInteractive = false) {
  if (forceInteractive) clearState();
  let state = readState();
  if (state.access_token && Number(state.expires_at || 0) > Date.now() + 60000)
    return state;
  if (!forceInteractive) {
    const refreshed = await refreshToken(state);
    if (refreshed) return refreshed;
  }
  return await interactiveAuthorize();
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const item of data) {
    try {
      return JSON.parse(item);
    } catch {}
  }
  throw new Error("Invalid MCP response from KMJ CodeBridge");
}

async function remoteRpc(method, params, token = null, id = 1) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(RESOURCE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (response.status === 401) {
    const error = new Error("KMJ CodeBridge authorization required");
    error.status = 401;
    throw error;
  }
  if (!response.ok)
    throw new Error(`KMJ CodeBridge MCP returned HTTP ${response.status}`);
  return parseMcpResponse(text);
}

function sanitizeTool(tool) {
  const copy = structuredClone(tool);
  delete copy.securitySchemes;
  if (copy._meta && typeof copy._meta === "object") {
    delete copy._meta.securitySchemes;
    delete copy._meta["mcp/www_authenticate"];
    if (Object.keys(copy._meta).length === 0) delete copy._meta;
  }
  return copy;
}

const accountTools = [
  {
    name: "codebridge_account_status",
    title: "KMJ CodeBridge account status",
    description:
      "Check whether the local Desktop bridge is connected to a KMJ account. Never returns access or refresh tokens.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codebridge_account_connect",
    title: "Connect KMJ CodeBridge account",
    description:
      "Open the user's default browser, complete KMJ OAuth, and securely store the resulting credentials in the local plugin data directory.",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codebridge_account_disconnect",
    title: "Disconnect KMJ CodeBridge account",
    description:
      "Delete the local Desktop OAuth credentials for KMJ CodeBridge. Does not revoke the user's KMJ account or project grants.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

async function toolsList() {
  if (cachedTools && Date.now() - cachedToolsAt < 30000) return cachedTools;
  const response = await remoteRpc("tools/list", {}, null, 1001);
  const remoteTools = Array.isArray(response?.result?.tools)
    ? response.result.tools.map(sanitizeTool)
    : [];
  cachedTools = [
    ...accountTools,
    ...remoteTools.filter(
      (tool) => !accountTools.some((local) => local.name === tool.name),
    ),
  ];
  cachedToolsAt = Date.now();
  return cachedTools;
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(name, args) {
  if (name === "codebridge_account_status") {
    const state = readState();
    const connected = Boolean(state.access_token || state.refresh_token);
    return textResult({
      connected,
      endpoint: RESOURCE,
      scope: connected ? state.scope || SCOPES : null,
      expiresAt:
        connected && state.expires_at
          ? new Date(state.expires_at).toISOString()
          : null,
      connectedAt: connected ? state.connected_at || null : null,
      credentialStorage: TOKEN_FILE,
    });
  }
  if (name === "codebridge_account_connect") {
    const state = await ensureToken(Boolean(args?.force));
    return textResult({
      connected: true,
      endpoint: RESOURCE,
      scope: state.scope || SCOPES,
      expiresAt: state.expires_at
        ? new Date(state.expires_at).toISOString()
        : null,
    });
  }
  if (name === "codebridge_account_disconnect") {
    clearState();
    return textResult({ disconnected: true, endpoint: RESOURCE });
  }

  let state = await ensureToken(false);
  let response;
  try {
    response = await remoteRpc(
      "tools/call",
      { name, arguments: args || {} },
      state.access_token,
      2001,
    );
  } catch (error) {
    if (error.status !== 401) throw error;
    clearState();
    state = await ensureToken(false);
    response = await remoteRpc(
      "tools/call",
      { name, arguments: args || {} },
      state.access_token,
      2002,
    );
  }
  if (response?.error)
    throw new Error(
      response.error.message || "KMJ CodeBridge tool call failed",
    );
  return (
    response?.result || textResult("KMJ CodeBridge returned no result", true)
  );
}

async function handle(message) {
  if (!message || typeof message !== "object") return null;
  if (message.method === "notifications/initialized") return null;
  if (message.id === undefined) return null;
  const id = message.id;
  try {
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: message.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "kmj-codebridge-desktop",
              title: "KMJ CodeBridge",
              version: VERSION,
            },
            instructions:
              "Use codebridge_account_connect when the KMJ account is not connected. Remote project tools automatically trigger browser OAuth on first use.",
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: await toolsList() } };
      case "tools/call":
        return {
          jsonrpc: "2.0",
          id,
          result: await callTool(
            message.params?.name,
            message.params?.arguments || {},
          ),
        };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      result: textResult(error?.message || String(error), true),
    };
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n",
    );
    return;
  }
  const response = await handle(message);
  if (response) process.stdout.write(JSON.stringify(response) + "\n");
});
rl.on("close", () => process.exit(0));
