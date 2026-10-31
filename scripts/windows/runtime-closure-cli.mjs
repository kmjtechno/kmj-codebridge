// Read-only CLI around runtime-closure.js. Never modifies the runtime; `build` writes ONLY the manifest file
// given by --out (must be outside --root, never overwritten). Output is the manifest SHA-256 and fixed codes.
//   node runtime-closure-cli.mjs build  --root R --tenant T --device D --project P --node-exe N --out M.json
//   node runtime-closure-cli.mjs verify --root R --manifest M.json --pin <sha256> [--node-exe N]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import {
  buildManifest,
  manifestSha256,
  sha256File,
  verifyRuntime,
  verifyNode,
  ClosureError,
} from "./runtime-closure.js";

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
    const rel = relative(root, resolve(a.out));
    if (!rel.startsWith("..") && !isAbsolute(rel))
      throw new ClosureError("CLI_OUT_INSIDE_RUNTIME");
    const manifest = buildManifest(root, {
      tenant: a.tenant,
      deviceId: a.device,
      projectId: a.project,
      nodeSha256: sha256File(a["node-exe"]),
    });
    writeFileSync(a.out, JSON.stringify(manifest, null, 2), { flag: "wx" });
    console.log(`MANIFEST_SHA256=${manifestSha256(manifest)}`);
    console.log(`FILES=${Object.keys(manifest.files).length}`);
  } else if (cmd === "verify") {
    for (const k of ["root", "manifest", "pin"])
      if (!a[k]) throw new ClosureError("CLI_USAGE");
    const manifest = JSON.parse(readFileSync(a.manifest, "utf8"));
    verifyRuntime(resolve(a.root), manifest, a.pin);
    if (a["node-exe"]) verifyNode(a["node-exe"], manifest);
    console.log("RUNTIME_CLOSURE_OK");
  } else throw new ClosureError("CLI_USAGE");
} catch (e) {
  console.log(
    `RUNTIME_CLOSURE_FAIL ${e instanceof ClosureError ? e.code : "UNEXPECTED"}`,
  );
  process.exitCode = 2;
}
