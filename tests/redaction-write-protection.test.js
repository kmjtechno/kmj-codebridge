import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDispatcher,
  preservesSensitiveBindings,
  sensitiveBindings,
} from "../src/tools.js";

function setup(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-sensitive-bindings-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const config = {
    id: "d1",
    projects: [{ id: "p1", root, writable: true, gates: {} }],
  };
  const runner = { maxConcurrent: 1 };
  const licenseProvider = () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dispatch: createDispatcher(config, runner, licenseProvider),
  };
}

const scope = { device: "d1", project: "p1" };

test("extracts the same sensitive binding identities independent of separator whitespace", () => {
  const pem = [
    "-----BEGIN ",
    "TEST PRIVATE KEY-----\nfixture\n-----END TEST PRIVATE KEY-----",
  ].join("");
  assert.deepEqual(
    sensitiveBindings(
      `Bearer shorttoken\ntoken = alpha\napi_key=beta\n${pem}\n`,
    ),
    [
      ["bearer", "shorttoken"],
      ["kv", "token", "alpha"],
      ["kv", "apikey", "beta"],
      ["private-key", pem],
    ],
  );
});

test("multiset comparison preserves duplicate count and key identity", () => {
  assert.equal(
    preservesSensitiveBindings(
      "token=alpha\ntoken=alpha\n",
      "token=alpha\ntoken=alpha\nmode=fast\n",
    ),
    true,
  );
  assert.equal(
    preservesSensitiveBindings("token=alpha\ntoken=alpha\n", "token=alpha\n"),
    false,
  );
  assert.equal(
    preservesSensitiveBindings("token=alpha\n", "password=alpha\n"),
    false,
  );
});

test("unrelated edit succeeds while the original sensitive binding remains byte-identical", async (t) => {
  const { root, dispatch } = setup(t, {
    "config.txt": "mode=slow\ntoken=alpha\n",
  });
  const before = await dispatch("read_file", { ...scope, path: "config.txt" }, [
    "read",
  ]);
  const changed = await dispatch(
    "edit_file",
    {
      ...scope,
      path: "config.txt",
      oldText: "mode=slow",
      newText: "mode=fast",
      expectedHash: before.sha256,
    },
    ["write"],
  );
  assert.equal(changed.changed, true);
  assert.equal(
    fs.readFileSync(path.join(root, "config.txt"), "utf8"),
    "mode=fast\ntoken=alpha\n",
  );
});

test("moving a bound value into a comment or another key is rejected", async (t) => {
  const { dispatch } = setup(t, { "config.txt": "token=alpha\n" });
  const before = await dispatch("read_file", { ...scope, path: "config.txt" }, [
    "read",
  ]);
  for (const replacement of ["// alpha\n", "password=alpha\n"]) {
    await assert.rejects(
      () =>
        dispatch(
          "edit_file",
          {
            ...scope,
            path: "config.txt",
            oldText: "token=alpha\n",
            newText: replacement,
            expectedHash: before.sha256,
          },
          ["write"],
        ),
      /SENSITIVE_CONTENT_PROTECTED/,
    );
  }
});

test("write_file rejects replacement or truncation of an existing binding", async (t) => {
  const { dispatch } = setup(t, { "config.txt": "api_key=fixture-key\n" });
  const before = await dispatch("read_file", { ...scope, path: "config.txt" }, [
    "read",
  ]);
  await assert.rejects(
    () =>
      dispatch(
        "write_file",
        {
          ...scope,
          path: "config.txt",
          content: "api_key=fixture\n",
          expectedHash: before.sha256,
        },
        ["write"],
      ),
    /SENSITIVE_CONTENT_PROTECTED/,
  );
});

test("atomic multi-file write remains all-or-nothing when one sensitive binding changes", async (t) => {
  const { root, dispatch } = setup(t, {
    "protected.txt": "token=alpha\n",
    "plain.txt": "before\n",
  });
  const protectedFile = await dispatch(
    "read_file",
    { ...scope, path: "protected.txt" },
    ["read"],
  );
  const plainFile = await dispatch(
    "read_file",
    { ...scope, path: "plain.txt" },
    ["read"],
  );
  await assert.rejects(
    () =>
      dispatch(
        "write_files_atomic",
        {
          ...scope,
          changes: [
            {
              path: "protected.txt",
              content: "token=beta\n",
              expectedHash: protectedFile.sha256,
            },
            {
              path: "plain.txt",
              content: "after\n",
              expectedHash: plainFile.sha256,
            },
          ],
        },
        ["write"],
      ),
    /SENSITIVE_CONTENT_PROTECTED/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "plain.txt"), "utf8"),
    "before\n",
  );
});

test("separator-only formatting and harmless token-named identifiers stay editable", async (t) => {
  const { root, dispatch } = setup(t, {
    "config.txt": "token=alpha\n",
    "code.js": "const tokenName = input.tokenName;\n",
  });
  const config = await dispatch("read_file", { ...scope, path: "config.txt" }, [
    "read",
  ]);
  await dispatch(
    "edit_file",
    {
      ...scope,
      path: "config.txt",
      oldText: "token=alpha",
      newText: "token = alpha",
      expectedHash: config.sha256,
    },
    ["write"],
  );
  assert.equal(
    fs.readFileSync(path.join(root, "config.txt"), "utf8"),
    "token = alpha\n",
  );

  const code = await dispatch("read_file", { ...scope, path: "code.js" }, [
    "read",
  ]);
  assert.deepEqual(sensitiveBindings("const tokenName = input.tokenName;"), []);
  await dispatch(
    "edit_file",
    {
      ...scope,
      path: "code.js",
      oldText: "input.tokenName",
      newText: "input.tokenName ?? null",
      expectedHash: code.sha256,
    },
    ["write"],
  );
});
