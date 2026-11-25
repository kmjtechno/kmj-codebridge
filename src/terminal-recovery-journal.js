import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const NAME = /^kmj-terminal-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const DAEMON = /^[A-Za-z0-9._:-]{1,128}$/;
const LIMIT = 2048;

function validIntent(intent) {
  return (
    intent?.version === 1 &&
    typeof intent.name === "string" &&
    NAME.test(intent.name) &&
    typeof intent.imageId === "string" &&
    IMAGE.test(intent.imageId) &&
    typeof intent.daemonId === "string" &&
    DAEMON.test(intent.daemonId) &&
    Object.keys(intent).length === 4
  );
}

// No name-only or label-only adoption. A create that lost its ID is
// ambiguous and requires separate operator reconciliation.
export function planTerminalRecovery(intent, boundId, observation) {
  if (!validIntent(intent)) throw new Error("TERMINAL_RECOVERY_INVALID_INTENT");
  if (typeof boundId !== "string" || !ID.test(boundId))
    return { state: "AMBIGUOUS_CREATE", removeId: null };
  if (observation?.daemonId !== intent.daemonId)
    return { state: "DAEMON_MISMATCH", removeId: null };
  if (observation.status === "absent" && observation.queriedId === boundId)
    return { state: "EXACT_ID_ABSENT", removeId: null };
  if (
    observation.status !== "present" ||
    observation.queriedId !== boundId ||
    observation.id !== boundId ||
    observation.name !== intent.name ||
    observation.imageId !== intent.imageId ||
    observation.label !== "isolated-terminal"
  )
    return { state: "IDENTITY_UNVERIFIED", removeId: null };
  return { state: "EXACT_ID_CLEANUP_CANDIDATE", removeId: boundId };
}

function privateDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    fs.realpathSync(dir) !== dir
  )
    throw new Error("TERMINAL_RECOVERY_UNTRUSTED_DIRECTORY");
}

function syncDirectory(dir) {
  const fd = fs.openSync(
    dir,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusive(file, record) {
  const payload = JSON.stringify(record);
  if (Buffer.byteLength(payload) > LIMIT)
    throw new Error("TERMINAL_RECOVERY_RECORD_TOO_LARGE");
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

function readPrivate(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid() ||
      (st.mode & 0o077) !== 0 ||
      st.size > LIMIT
    )
      throw new Error("TERMINAL_RECOVERY_UNTRUSTED_RECORD");
    const data = Buffer.alloc(LIMIT + 1);
    const size = fs.readSync(fd, data, 0, data.length, 0);
    if (size !== st.size || size > LIMIT)
      throw new Error("TERMINAL_RECOVERY_UNTRUSTED_RECORD");
    return JSON.parse(data.subarray(0, size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// Internal Linux-only persistence. The caller must own a dedicated,
// operator-provisioned state root and the existing single-agent lock.
// Windows requires a separately verified private ACL implementation.
export class TerminalRecoveryJournal {
  constructor(stateDir) {
    if (process.platform !== "linux")
      throw new Error("TERMINAL_RECOVERY_PRIVATE_STORAGE_UNVERIFIED");
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir))
      throw new Error("TERMINAL_RECOVERY_INVALID_STATE_ROOT");
    this.root = path.resolve(stateDir);
    privateDirectory(this.root);
    this.dir = path.join(this.root, "terminal-recovery");
    try {
      fs.mkdirSync(this.dir, { mode: 0o700 });
      syncDirectory(this.root);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    privateDirectory(this.dir);
  }

  file(name, suffix) {
    if (typeof name !== "string" || !NAME.test(name))
      throw new Error("TERMINAL_RECOVERY_INVALID_NAME");
    privateDirectory(this.root);
    privateDirectory(this.dir);
    return path.join(this.dir, name + suffix);
  }

  begin({ imageId, daemonId }) {
    const intent = {
      version: 1,
      name: "kmj-terminal-" + randomUUID(),
      imageId,
      daemonId,
    };
    if (!validIntent(intent))
      throw new Error("TERMINAL_RECOVERY_INVALID_INTENT");
    writeExclusive(this.file(intent.name, ".intent"), intent);
    return intent;
  }

  bind(name, id) {
    if (typeof id !== "string" || !ID.test(id))
      throw new Error("TERMINAL_RECOVERY_INVALID_ID");
    const intent = this.readIntent(name);
    writeExclusive(this.file(name, ".bound"), {
      version: 1,
      name: intent.name,
      id,
    });
  }

  complete(name, id) {
    const record = this.read(name);
    if (record.boundId !== id || typeof id !== "string")
      throw new Error("TERMINAL_RECOVERY_INVALID_BINDING");
    writeExclusive(this.file(name, ".complete"), {
      version: 1,
      name,
      id,
    });
  }

  completion(name) {
    const record = this.read(name);
    let completed;
    try {
      completed = readPrivate(this.file(name, ".complete"));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (
      completed?.version !== 1 ||
      completed.name !== name ||
      typeof completed.id !== "string" ||
      completed.id !== record.boundId ||
      Object.keys(completed).length !== 3
    )
      throw new Error("TERMINAL_RECOVERY_INVALID_COMPLETION");
    return true;
  }

  readIntent(name) {
    const intent = readPrivate(this.file(name, ".intent"));
    if (!validIntent(intent) || intent.name !== name)
      throw new Error("TERMINAL_RECOVERY_INVALID_INTENT");
    return intent;
  }

  read(name) {
    const intent = this.readIntent(name);
    let binding;
    try {
      binding = readPrivate(this.file(name, ".bound"));
    } catch (error) {
      if (error.code === "ENOENT") return { intent, boundId: null };
      throw error;
    }
    if (
      binding?.version !== 1 ||
      binding.name !== name ||
      typeof binding.id !== "string" ||
      !ID.test(binding.id) ||
      Object.keys(binding).length !== 3
    )
      throw new Error("TERMINAL_RECOVERY_INVALID_BINDING");
    return { intent, boundId: binding.id };
  }
}
