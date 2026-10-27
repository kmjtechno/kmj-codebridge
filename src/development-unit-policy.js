import { createHash } from "node:crypto";

// Security contract: this is a root-owned FIXED non-root probe unit, not an AI
// coding executor. It must not accept caller commands, environment, or paths.
export const DEVELOPMENT_UNIT = "kmj-codebridge-development-ci.service";
export const DEVELOPMENT_UNIT_PATH =
  "/etc/systemd/system/kmj-codebridge-development-ci.service";
export const DEVELOPMENT_HELPER_PATH =
  "/usr/local/libexec/kmj-codebridge-dev-probe.py";
export const DEVELOPMENT_HELPER_SHA256 =
  "1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7";

export const DEVELOPMENT_UNIT_CONTENT = [
  "[Unit]",
  "Description=KMJ CodeBridge pinned non-root development CI probe",
  "ConditionPathIsDirectory=/srv/kmj-codebridge-projects/kmj-main-platform",
  "",
  "[Service]",
  "Type=oneshot",
  "User=kmjdevci",
  "Group=kmjdevci",
  "WorkingDirectory=/var/lib/kmj-codebridge-development-ci",
  "ExecStart=/usr/bin/python3 -I /usr/local/libexec/kmj-codebridge-dev-probe.py",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ProtectHome=yes",
  "PrivateTmp=yes",
  "PrivateDevices=yes",
  "PrivateNetwork=yes",
  "RestrictSUIDSGID=yes",
  "LockPersonality=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectControlGroups=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "RestrictAddressFamilies=AF_UNIX",
  "IPAddressDeny=any",
  "ReadWritePaths=/var/lib/kmj-codebridge-development-ci",
  "MemoryMax=268435456",
  "TasksMax=32",
  "UMask=0077",
  "",
].join("\n");

const PROPERTIES = [
  "LoadState",
  "ActiveState",
  "FragmentPath",
  "DropInPaths",
  "User",
  "Group",
  "NoNewPrivileges",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "PrivateNetwork",
  "CapabilityBoundingSet",
  "AmbientCapabilities",
  "EnvironmentFiles",
  "ReadWritePaths",
];

function ownedFile(lstat, file, max) {
  const s = lstat(file);
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    s.nlink === 1 &&
    (s.mode & 0o022) === 0 &&
    s.size > 0 &&
    s.size <= max
  );
}

function ownedDirectory(lstat, file) {
  const s = lstat(file);
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    s.uid === 0 &&
    (s.mode & 0o022) === 0
  );
}

const SAFE_PROPERTIES = Object.freeze({
  LoadState: "loaded",
  FragmentPath: DEVELOPMENT_UNIT_PATH,
  DropInPaths: "",
  User: "kmjdevci",
  Group: "kmjdevci",
  NoNewPrivileges: "yes",
  ProtectSystem: "strict",
  ProtectHome: "yes",
  PrivateTmp: "yes",
  PrivateDevices: "yes",
  PrivateNetwork: "yes",
  CapabilityBoundingSet: "",
  AmbientCapabilities: "",
  EnvironmentFiles: "",
  ReadWritePaths: "/var/lib/kmj-codebridge-development-ci",
});

export function attestDevelopmentCi({ run, lstat, readFile }) {
  const blocked = (reason, installed = false) => ({
    unit: DEVELOPMENT_UNIT,
    installed,
    ready: false,
    reason,
    runsAsRoot: false,
    productionReleaseApproved: false,
  });
  let props;
  try {
    const output = String(
      run("/usr/bin/systemctl", [
        "show",
        DEVELOPMENT_UNIT,
        ...PROPERTIES.map((name) => `--property=${name}`),
        "--no-pager",
      ]),
    );
    if (output.length > 8192) return blocked("UNIT_PROPERTIES_UNVERIFIED");
    props = {};
    for (const line of output.trim().split("\n")) {
      const i = line.indexOf("=");
      if (i < 1) return blocked("UNIT_PROPERTIES_UNVERIFIED");
      const key = line.slice(0, i);
      if (!PROPERTIES.includes(key) || Object.hasOwn(props, key))
        return blocked("UNIT_PROPERTIES_UNVERIFIED");
      props[key] = line.slice(i + 1);
    }
    if (props.LoadState === "not-found") return blocked("UNIT_NOT_INSTALLED");
    for (const [key, expected] of Object.entries(SAFE_PROPERTIES)) {
      if (props[key] !== expected)
        return blocked("UNIT_PROPERTIES_UNSAFE", true);
    }
    if (props.ActiveState !== "inactive")
      return blocked("UNIT_NOT_IDLE", true);
  } catch {
    return blocked("UNIT_PROPERTIES_UNAVAILABLE");
  }

  try {
    if (
      !ownedDirectory(lstat, "/etc/systemd/system") ||
      !ownedDirectory(lstat, "/usr/local/libexec") ||
      !ownedFile(lstat, DEVELOPMENT_UNIT_PATH, 8192) ||
      !ownedFile(lstat, DEVELOPMENT_HELPER_PATH, 16384)
    )
      return blocked("ROOT_OWNERSHIP_UNVERIFIED", true);

    const unit = readFile(DEVELOPMENT_UNIT_PATH);
    if (unit !== DEVELOPMENT_UNIT_CONTENT)
      return blocked("UNIT_CONTENT_MISMATCH", true);
    const helper = readFile(DEVELOPMENT_HELPER_PATH);
    if (
      typeof helper !== "string" ||
      createHash("sha256").update(helper).digest("hex") !==
        DEVELOPMENT_HELPER_SHA256
    )
      return blocked("HELPER_HASH_MISMATCH", true);
  } catch {
    return blocked("ROOT_FILES_UNAVAILABLE", true);
  }

  return {
    unit: DEVELOPMENT_UNIT,
    installed: true,
    ready: true,
    reason: "PINNED_NONROOT_UNIT_VERIFIED",
    runsAsRoot: false,
    productionReleaseApproved: false,
  };
}
