// Read-only CLI around runtime-closure.js. Never modifies the runtime; `build` writes ONLY the manifest file
// given by --out (must be outside --root, never overwritten). Output is the manifest SHA-256 and fixed codes.
// NOTE: assertCleanNodeEnvironment runs only after Node has already loaded this CLI, so it is NOT
// pre-execution trust. The launcher must start Node with a scrubbed environment from a trusted path.
//   node runtime-closure-cli.mjs build  --root R --tenant T --device D --project P --node-exe N --out M.json
//   node runtime-closure-cli.mjs verify --root R --manifest M.json --pin <sha256> --node-exe <the running node>
import {
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import {
  buildManifest,
  manifestSha256,
  sha256File,
  verifyRuntime,
  verifyNode,
  assertCleanNodeEnvironment,
  ClosureError,
} from "./runtime-closure.js";

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// The manifest must never be created inside the covered runtime, not even through a symlink/junction
// parent: every ancestor of the output must be a real directory, and the REAL parent must lie outside the
// REAL runtime root. The file itself is created exclusively (O_EXCL never follows a final link) and its
// real location is re-checked afterwards.
function assertOutsideRuntime(root, out) {
  const abs = resolve(out);
  if (inside(resolve(root), abs))
    throw new ClosureError("CLI_OUT_INSIDE_RUNTIME");
  let cur = dirname(abs);
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new ClosureError("CLI_OUT_PARENT_MISSING");
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ClosureError("CLI_OUT_LINKED");
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (inside(realpathSync(root), realpathSync(dirname(abs))))
    throw new ClosureError("CLI_OUT_INSIDE_RUNTIME");
  return abs;
}

function args(argv) {
  const out = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
      throw new ClosureError("CLI_USAGE");
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

try {
  const cmd = process.argv[2];
  const a = args(process.argv.slice(2));
  if (cmd === "build") {
    for (const k of ["root", "tenant", "device", "project", "node-exe", "out"])
      if (!a[k]) throw new ClosureError("CLI_USAGE");
    const root = resolve(a.root);
    const out = assertOutsideRuntime(root, a.out);
    const manifest = buildManifest(root, {
      tenant: a.tenant,
      deviceId: a.device,
      projectId: a.project,
      nodeSha256: sha256File(a["node-exe"]),
    });
    writeFileSync(out, JSON.stringify(manifest, null, 2), { flag: "wx" });
    if (inside(realpathSync(root), realpathSync(out))) {
      unlinkSync(out); // created by this call a moment ago
      throw new ClosureError("CLI_OUT_INSIDE_RUNTIME");
    }
    console.log(`MANIFEST_SHA256=${manifestSha256(manifest)}`);
    console.log(`FILES=${Object.keys(manifest.files).length}`);
  } else if (cmd === "verify") {
    // --node-exe is MANDATORY and must be the interpreter actually running this check, so the
    // approved node.exe hash binds the real process (no hash bypass, no hashing a different binary).
    for (const k of ["root", "manifest", "pin", "node-exe"])
      if (!a[k]) throw new ClosureError("CLI_USAGE");
    if (lstatSync(a["node-exe"]).isSymbolicLink())
      throw new ClosureError("NODE_EXE_LINKED");
    if (
      realpathSync(a["node-exe"]).toLowerCase() !==
      realpathSync(process.execPath).toLowerCase()
    )
      throw new ClosureError("NODE_NOT_RUNNING_EXE");
    const manifest = JSON.parse(readFileSync(a.manifest, "utf8"));
    assertCleanNodeEnvironment(resolve(a.root), { home: homedir() });
    verifyRuntime(resolve(a.root), manifest, a.pin);
    verifyNode(a["node-exe"], manifest);
    console.log("RUNTIME_CLOSURE_OK");
  } else throw new ClosureError("CLI_USAGE");
} catch (e) {
  console.log(
    `RUNTIME_CLOSURE_FAIL ${e instanceof ClosureError ? e.code : "UNEXPECTED"}`,
  );
  process.exitCode = 2;
}
