// Optional read-only snapshot of authorized project structure and tracked diff.
// These inputs originate from already scoped CodeBridge read tools. This module
// deliberately excludes file contents, untracked file bytes and arbitrary paths.
const MAX_ENTRIES = 48;
const MAX_PATCH_BYTES = 24576;
const ALLOWED_TYPES = new Set(["file", "directory"]);
const BAD_SEGMENT =
  /^(?:\.\.?|\.git|\.env(?:\..*)?|node_modules|\.codebridge-.*)$/i;

function safePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\\:\x00-\x1f]/.test(value) ||
    value.startsWith("/")
  )
    return false;
  return value.split("/").every((segment) => {
    return (
      segment.length > 0 && !BAD_SEGMENT.test(segment) && !/[<>]/.test(segment)
    );
  });
}

export function buildMissionWorkspace({
  project,
  tree,
  diff,
  now = Date.now(),
}) {
  const result = {
    source: "AUTHORIZED_PROJECT_READS",
    observedAt: null,
    tree: { status: "UNAVAILABLE", entries: [], truncated: null },
    diff: { status: "UNAVAILABLE", patch: null, truncated: null },
  };
  if (
    typeof project !== "string" ||
    !project ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return result;
  result.observedAt = new Date(now).toISOString();

  if (
    tree?.ok &&
    tree.value?.path === "" &&
    Array.isArray(tree.value.entries) &&
    tree.value.entries.length <= MAX_ENTRIES
  ) {
    const entries = [];
    let good = true;
    for (const item of tree.value.entries) {
      if (
        !item ||
        !safePath(item.path) ||
        !ALLOWED_TYPES.has(item.type) ||
        !Number.isInteger(item.depth) ||
        item.depth < 0 ||
        item.depth > 3
      ) {
        good = false;
        break;
      }
      entries.push({
        path: item.path,
        type: item.type,
        depth: item.depth,
      });
    }
    if (good) {
      result.tree = {
        status: "AVAILABLE",
        entries,
        truncated: tree.value.truncated === true,
      };
    }
  }

  if (diff?.ok && typeof diff.value?.diff === "string") {
    const patch = diff.value.diff;
    // Agent tool already returns a redacted bounded git diff. The gateway
    // imposes a smaller UI budget and marks its own truncation honestly.
    result.diff = {
      status: "AVAILABLE",
      patch: patch.slice(0, MAX_PATCH_BYTES),
      truncated:
        diff.value.truncated === true || patch.length > MAX_PATCH_BYTES,
    };
  }
  return result;
}
