import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  MOLI_VERSION,
  parseMoliResult,
  selectedMoliBinary,
  createMoliPrivateEnvironment,
  moliFetch,
  fastBrowserProbe,
} from "../scripts/browser-moli-fast.mjs";
import { tryFileSymlink } from "./windows-symlink-capability.js";

const expected = "https://kmjtechno.com/products";
const sample = () =>
  JSON.stringify({
    final_url: expected,
    status: 200,
    html: "<html><body><main>Real public product content with many visible words.</main></body></html>",
  });

test("Moli pin and JSON probe are explicit about actual URL/status", () => {
  assert.equal(MOLI_VERSION, "1.1.18");
  const data = parseMoliResult(sample(), expected);
  assert.equal(data.httpStatus, 200);
  assert.ok(data.htmlBytes > 40);
  assert.match(data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(data).includes("Real public product"), false);
  assert.throws(
    () => parseMoliResult(sample(), "https://evil.example/products"),
    /MOLI_NAVIGATION_UNVERIFIED/,
  );
  assert.throws(
    () =>
      parseMoliResult(
        JSON.stringify({
          final_url: expected,
          status: 403,
          html: "<html>content</html>",
        }),
        expected,
      ),
    /MOLI_HTTP_NOT_200/,
  );
  assert.throws(
    () => parseMoliResult("invalid JSON", expected),
    /MOLI_OUTPUT_INVALID/,
  );
  assert.throws(() => parseMoliResult("[]", expected), /MOLI_OUTPUT_INVALID/);
  assert.throws(
    () =>
      parseMoliResult(
        JSON.stringify({ final_url: expected, status: 200, html: "" }),
        expected,
      ),
    /MOLI_EMPTY_BODY/,
  );
});

test("Moli selection rejects missing candidates without symlink privileges", () => {
  assert.equal(
    selectedMoliBinary([path.join(os.tmpdir(), "kmj-moli-no-such-binary")]),
    null,
  );
});

test("Moli selection rejects symlink candidates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-binary-test-"));
  try {
    const real = path.join(root, "moli");
    const sym = path.join(root, "moli-link");
    fs.writeFileSync(real, "fake binary");
    if (!tryFileSymlink(t, real, sym)) {
      t.skip(
        "Windows cannot create symlink fixture; security assertion NOT EXECUTED",
      );
      return;
    }
    assert.equal(selectedMoliBinary([sym, real]), real);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Moli private environment isolates parent tokens and works on every OS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-env-"));
  try {
    for (const platform of ["win32", "darwin", "linux"]) {
      const dir = path.join(root, platform);
      fs.mkdirSync(dir);
      const env = createMoliPrivateEnvironment(
        dir,
        {
          PATH: "/bin",
          SYSTEMROOT: "C:\\Windows",
          CODEBRIDGE_DEVICE_TOKEN: "sensitive_device_token",
          AWS_SECRET_ACCESS_KEY: "secret_cloud_key",
          HTTP_PROXY: "http://proxy-secret.example:8080",
          HOME: "/private/owner",
        },
        platform,
      );
      assert.equal(env.PATH, "/bin");
      assert.equal(env.CODEBRIDGE_DEVICE_TOKEN, undefined);
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.HTTP_PROXY, undefined);
      assert.ok(!JSON.stringify(env).includes("sensitive_device_token"));
      assert.ok(!JSON.stringify(env).includes("secret_cloud_key"));
      assert.ok(!JSON.stringify(env).includes("proxy-secret"));
      assert.ok(!JSON.stringify(env).includes("/private/owner"));
      assert.ok(env.HOME.startsWith(dir));
      assert.ok(env.XDG_CONFIG_HOME.startsWith(dir));
      assert.ok(env.XDG_CACHE_HOME.startsWith(dir));
      if (platform === "win32") {
        assert.equal(env.USERPROFILE, env.HOME);
        assert.ok(env.TEMP.startsWith(dir));
        assert.ok(env.APPDATA.startsWith(dir));
        assert.ok(env.LOCALAPPDATA.startsWith(dir));
      }
      assert.ok(fs.statSync(env.HOME).isDirectory());
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Moli refuses nonapproved URLs before launching an executable", async () => {
  let launched = false;
  const spawnFn = () => {
    launched = true;
    throw Error("must not execute");
  };
  for (const url of [
    "https://example.com/",
    "https://kmjtechno.com/admin",
    "http://169.254.169.254/",
    "file:///etc/passwd",
    "https://kmjtechno.com/products?next=https://evil.invalid",
  ]) {
    await assert.rejects(
      moliFetch(url, { executable: "test-moli", spawnFn }),
      /MOLI_TARGET_NOT_ALLOWED/,
    );
  }
  assert.equal(launched, false);
});

test(
  "Moli fixed public job uses isolated child environment without secrets",
  { skip: process.platform !== "win32" && process.getuid?.() === 0 },
  async () => {
    let options;
    let args;
    let executable;
    const spawnFn = (binary, argv, opts) => {
      executable = binary;
      args = argv;
      options = opts;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(sample(), "utf8"));
        child.emit("close", 0);
      });
      return child;
    };
    const result = await moliFetch(expected, {
      executable: "test-moli",
      spawnFn,
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(executable, "test-moli");
    assert.deepEqual(args.slice(-1), [expected]);
    assert.ok(args.includes("--block-private-networks"));
    assert.ok(args.includes("--disable-subframes"));
    assert.equal(options.shell, false);
    assert.equal(options.env.CODEBRIDGE_DEVICE_TOKEN, undefined);
    assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.ok(options.env.HOME);
    assert.ok(options.env.TMPDIR);
    assert.equal(options.env.HTTP_PROXY, undefined);
    if (process.platform === "win32") {
      assert.ok(options.env.APPDATA);
      assert.ok(options.env.USERPROFILE);
      assert.ok(options.env.TEMP);
    }
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  },
);

test(
  "Moli fast lane stores bounded public metadata, never raw page HTML",
  {
    skip: process.platform !== "win32" && process.getuid?.() === 0,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-qa-test-"));
    const output = path.join(root, "receipt");
    const seen = [];
    try {
      const result = await fastBrowserProbe("kmj_public", output, {
        moli: async (url) => {
          seen.push(url);
          return { httpStatus: 200, htmlBytes: 1024, sha256: "a".repeat(64) };
        },
        chrome: async () => {
          throw Error("CHROME_MUST_NOT_START");
        },
      });
      assert.deepEqual(seen, [
        "https://kmjtechno.com/",
        "https://kmjtechno.com/products",
        "https://kmjtechno.com/login",
      ]);
      assert.equal(result.mode, "moli_semantic");
      assert.equal(result.verdict, "EXTRACTION_PASS");
      assert.equal(result.samples.length, 3);
      const receipt = fs.readFileSync(
        path.join(output, "receipt.json"),
        "utf8",
      );
      assert.ok(!receipt.includes("<html"));
      assert.throws(
        () =>
          fs.writeFileSync(path.join(output, "receipt.json"), "overwrite", {
            flag: "wx",
          }),
        /EEXIST/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Moli failure routes to Chrome but never hides Chrome FAIL",
  {
    skip: process.platform !== "win32" && process.getuid?.() === 0,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-fallback-"));
    try {
      let chromeCalls = 0;
      const failed = await fastBrowserProbe(
        "kmj_public",
        path.join(root, "failed"),
        {
          moli: async () => {
            throw Error("MOLI_NOT_INSTALLED");
          },
          chrome: async (target, output) => {
            chromeCalls++;
            assert.equal(target, "kmj_public");
            assert.ok(output.endsWith(path.sep + "chrome"));
            return {
              verdict: "FAIL",
              samples: [{ failures: ["HTTP_NOT_200"] }],
              reason: "BROWSER_QA_FAILED",
            };
          },
        },
      );
      assert.equal(failed.mode, "chrome_fidelity_fallback");
      assert.equal(failed.verdict, "FAIL");
      assert.equal(failed.fallbackReason, "MOLI_NOT_INSTALLED");
      assert.equal(chromeCalls, 1);

      const passed = await fastBrowserProbe(
        "kmj_public",
        path.join(root, "passed"),
        {
          moli: async () => {
            throw Error("MOLI_NOT_INSTALLED");
          },
          chrome: async () => ({
            verdict: "PASS",
            samples: Array(9).fill({ failures: [] }),
          }),
        },
      );
      assert.equal(passed.verdict, "CHROME_QA_PASS");
      assert.equal(passed.chromeSamples, 9);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("unapproved target is rejected before any engine or output directory", async () => {
  const target = path.join(os.tmpdir(), "kmj-unexpected-target-not-created");
  await assert.rejects(
    fastBrowserProbe("internal_admin", target),
    /BROWSER_TARGET_NOT_ALLOWED/,
  );
  assert.equal(fs.existsSync(target), false);
});

test("CodeBridge MCP fast probe shares bounded runner and does not expose arbitrary URLs", () => {
  const tools = fs.readFileSync(
    new URL("../src/tools.js", import.meta.url),
    "utf8",
  );
  const source = fs.readFileSync(
    new URL("../scripts/browser-moli-fast.mjs", import.meta.url),
    "utf8",
  );
  assert.match(tools, /browser_fast_probe:/);
  assert.match(tools, /if \(name === "browser_fast_probe"\)/);
  assert.match(tools, /gate: "browser-fast:kmj-public"/);
  assert.match(tools, /"kmj_public"/);
  assert.match(tools, /BROWSER_FAST_RUNTIME_NOT_DEPLOYED/);
  assert.match(source, /--block-private-networks/);
  assert.match(source, /--disable-subframes/);
  assert.doesNotMatch(source, /--no-sandbox|--remote-debugging-port|eval\(/);
});
