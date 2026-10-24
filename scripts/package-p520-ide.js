#!/usr/bin/env node
// Produce an offline, complete P520 IDE ZIP from reviewed repository files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_BOOTSTRAP_SHA256 =
  "D867A1F0131CCE424B0FA90AAA91A847ECFA404088409E341E9B1DF161AC60F5";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["START-KMJ-CALIBRATION-IDE.cmd", "scripts/windows/START-KMJ-CALIBRATION-IDE.cmd"],
  ["BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1", "scripts/windows/BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1"],
  ["READ-ME-FIRST.txt", "scripts/windows/P520-COMPLETE-IDE-README.txt"],
];

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  for (let k = 0; k < 8; k++) v = v & 1 ? (v >>> 1) ^ 0xedb88320 : v >>> 1;
  table[i] = v >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    if (!/^[A-Za-z0-9.-]+$/.test(name)) throw new Error("UNSAFE_ZIP_FILENAME");
    const filename = Buffer.from(name, "ascii");
    const checksum = crc32(bytes);
    const record = Buffer.alloc(30);
    record.writeUInt32LE(0x04034b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt32LE(checksum, 14);
    record.writeUInt32LE(bytes.length, 18);
    record.writeUInt32LE(bytes.length, 22);
    record.writeUInt16LE(filename.length, 26);
    local.push(record, filename, bytes);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(checksum, 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, filename);
    offset += record.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1].toLowerCase().endsWith(".zip")) {
    throw new Error("Usage: node scripts/package-p520-ide.js --out NEW-FILE.zip");
  }
  const entries = files.map(([name, relative]) => {
    const full = path.join(root, relative);
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("UNTRUSTED_PACKAGE_INPUT");
    return [name, fs.readFileSync(full)];
  });
  const script = entries[1][1];
  const launcher = entries[0][1].toString("utf8");
  if (
    sha256(script) !== EXPECTED_BOOTSTRAP_SHA256 ||
    !launcher.includes("'" + EXPECTED_BOOTSTRAP_SHA256 + "'") ||
    !launcher.includes("%~dp0BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1") ||
    !launcher.includes("IDE_SETUP=BLOCKED_BOOTSTRAP_SCRIPT_MISSING")
  ) {
    throw new Error("P520_INSTALLER_INTEGRITY_FAILED");
  }
  fs.writeFileSync(path.resolve(args[1]), zip(entries), { flag: "wx", mode: 0o600 });
  process.stdout.write("P520_IDE_PACKAGE=COMPLETE\nBOOTSTRAP_SHA256=PASS\n");
  process.stdout.write("P520_DEVICE_CONNECTION=NOT_ATTESTED\n");
}
main();
