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
  "NeedDaemonReload",
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
    // Reject setuid/setgid/sticky as well as group/world writable files.
    (s.mode & 0o7022) === 0 &&
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
    // A trusted parent directory must not carry special permission bits.
    (s.mode & 0o7022) === 0
  );
}

const SAFE_PROPERTIES = Object.freeze({
  LoadState: "loaded",
  FragmentPath: DEVELOPMENT_UNIT_PATH,
  DropInPaths: "",
  // Reject stale PID 1 loaded-unit bytes even when the on-disk unit is pinned.
  NeedDaemonReload: "no",
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

// Diagnostic-only fallback for a failed bulk systemctl query. It never
// authorizes starting the unit, even when every individual property matches.
// Only the fixed policy key NAMES are returned; effective values (paths,
// environment and credentials) stay entirely inside this function.
function classifyUnreadableDevelopmentProperties(run) {
  const missingProperties = [];
  const mismatchedProperties = [];
  for (const key of PROPERTIES) {
    let output;
    try {
      output = String(
        run("/usr/bin/systemctl", [
          "show",
          DEVELOPMENT_UNIT,
          `--property=${key}`,
          "--no-pager",
        ]),
      );
    } catch {
      missingProperties.push(key);
      continue;
    }
    // Fail closed on truncation, duplicate lines, injection or malformed
    // output, including non-printable characters, without returning values.
    if (output.length > 1024 || /[\r\0]/.test(output)) {
      missingProperties.push(key);
      continue;
    }
    const lines = output.replace(/\n$/, "").split("\n");
    if (lines.length !== 1 || !lines[0].startsWith(`${key}=`)) {
      missingProperties.push(key);
      continue;
    }
    const effective = lines[0].slice(key.length + 1);
    if (
      Object.hasOwn(SAFE_PROPERTIES, key) &&
      effective !== SAFE_PROPERTIES[key]
    )
      mismatchedProperties.push(key);
    if (key === "ActiveState" && effective !== "inactive")
      mismatchedProperties.push(key);
  }
  return { missingProperties, mismatchedProperties };
}

export function attestDevelopmentCi({ run, lstat, readFile }) {
  const blocked = (reason, installed = false) => ({
    unit: DEVELOPMENT_UNIT,
    installed,
    ready: false,
    reason,
    runsAsRoot: false,
    productionReleaseApproved: false,
  });
  // Malformed bulk output is never trusted for authorization. The fallback
  // queries fixed property names only and reports names, not effective values.
  const unreadable = () => ({
    ...blocked("UNIT_PROPERTIES_UNVERIFIED"),
    ...classifyUnreadableDevelopmentProperties(run),
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
    // Do not trim values: trailing whitespace in ReadWritePaths must not
    // turn an unsafe effective property into a false exact-policy match.
    if (output.length > 8192 || /[\r\0]/.test(output)) return unreadable();
    const lines = output.replace(/\n$/, "").split("\n");
    if (lines.length !== PROPERTIES.length) return unreadable();
    props = {};
    for (const line of lines) {
      const i = line.indexOf("=");
      if (i < 1) return unreadable();
      const key = line.slice(0, i);
      if (!PROPERTIES.includes(key) || Object.hasOwn(props, key))
        return unreadable();
      props[key] = line.slice(i + 1);
    }
    if (props.LoadState === "not-found") return blocked("UNIT_NOT_INSTALLED");
    // Report only fixed policy PROPERTY NAMES, never the effective values:
    // paths/environment/credential-like unit properties may contain secrets.
    // This diagnostic remains a failed attestation and cannot authorize start.
    const mismatchedProperties = Object.entries(SAFE_PROPERTIES)
      .filter(([key, expected]) => props[key] !== expected)
      .map(([key]) => key);
    if (mismatchedProperties.length)
      return {
        ...blocked("UNIT_PROPERTIES_UNSAFE", true),
        mismatchedProperties,
      };
    if (props.ActiveState !== "inactive") return blocked("UNIT_NOT_IDLE", true);
  } catch {
    // A failed multi-property read is *never* sufficient evidence to start.
    // A bounded diagnostic-only retry identifies fixed failing property names
    // without exposing their contents or changing the admission verdict.
    return {
      ...blocked("UNIT_PROPERTIES_UNAVAILABLE"),
      ...classifyUnreadableDevelopmentProperties(run),
    };
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
