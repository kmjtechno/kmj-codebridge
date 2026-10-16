import { fail } from "./errors.js";
// Narrow, reversible tool-policy extension point inspired by the scoped
// registration and monotonic guard seams in DeepSeek Harness (MIT).
// Trusted in-process registration only. Never loads third-party modules or
// evaluates model-provided code/configuration.
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS = new Set(["read", "write", "execute"]);

export function createToolGuardHost() {
  const entries = new Map();

  return {
    register({ id, project = null, beforeExecute }) {
      if (
        typeof id !== "string" ||
        !ID.test(id) ||
        (project !== null && (!PROJECT.test(project) || typeof project !== "string")) ||
        typeof beforeExecute !== "function" ||
        entries.has(id) ||
        entries.size >= 32
      )
        fail("TOOL_GUARD_REGISTRATION_INVALID");
      const owner = { id, project, beforeExecute };
      entries.set(id, owner);
      // The disposer owns only this registration; another consumer cannot
      // unload an unrelated extension. Calling it twice is harmless.
      return () => {
        if (entries.get(id) === owner) entries.delete(id);
      };
    },

    async preflight({ device, project, tool, access, writable }) {
      if (
        typeof device !== "string" ||
        !PROJECT.test(device) ||
        typeof project !== "string" ||
        !PROJECT.test(project) ||
        typeof tool !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(tool) ||
        !ACCESS.has(access) ||
        typeof writable !== "boolean"
      )
        fail("TOOL_GUARD_CONTEXT_INVALID");
      // Never give a plugin tool parameters, prompts, paths, secrets or
      // identity tokens. A plugin can ONLY deny, never grant authority.
      const facts = Object.freeze({ device, project, tool, access, writable });
      for (const entry of [...entries.values()]) {
        if (entries.get(entry.id) !== entry) continue;
        if (entry.project !== null && entry.project !== project) continue;
        let verdict;
        try {
          verdict = await entry.beforeExecute(facts);
        } catch {
          fail("TOOL_GUARD_FAILED");
        }
        if (verdict === "deny") fail("TOOL_GUARD_DENIED");
        if (verdict !== "allow" && verdict !== undefined)
          fail("TOOL_GUARD_INVALID_VERDICT");
      }
      return true;
    },

    status() {
      return {
        installed: entries.size,
        dynamicPluginLoading: false,
        canGrantPermissions: false,
      };
    },
  };
}

// Monotonic base policy. This is additional defense in depth; it does not
// replace MCP OAuth, project permissions, the command allowlist or audit.
export function registerReadOnlyProjectGuard(host) {
  return host.register({
    id: "readonly-project-writes",
    beforeExecute: (facts) =>
      facts.access === "write" && !facts.writable ? "deny" : "allow",
  });
}
