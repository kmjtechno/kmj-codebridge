// node:test reporter that turns failures into GitHub Actions error
// annotations. Check-run annotations are readable through the REST API even
// when job log blobs are not, so a failed CI run can be diagnosed from the
// exact failing test names and first error lines. It prints no environment,
// no secrets and at most MAX_ANNOTATIONS entries of bounded length.
const MAX_ANNOTATIONS = 10;
const MAX_LENGTH = 450;

function escapeData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

export default async function* githubAnnotationsReporter(source) {
  let emitted = 0;
  let failures = 0;
  for await (const event of source) {
    if (event.type !== "test:fail" || event.data?.details?.type === "suite")
      continue;
    failures += 1;
    if (emitted >= MAX_ANNOTATIONS) continue;
    emitted += 1;
    const error = event.data?.details?.error;
    const cause = error?.cause ?? error;
    const parts = [
      event.data?.name,
      cause?.code,
      cause?.message,
      cause?.expected !== undefined ? `expected=${String(cause.expected)}` : "",
      cause?.actual !== undefined ? `actual=${String(cause.actual)}` : "",
    ].filter(Boolean);
    const file = String(event.data?.file ?? "").replace(
      /^.*[\\/]tests[\\/]/,
      "tests/",
    );
    const text = escapeData(parts.join(" | ").slice(0, MAX_LENGTH));
    yield `::error file=${escapeData(file)},line=${event.data?.line ?? 1},title=Test failed::${text}\n`;
  }
  if (failures > MAX_ANNOTATIONS)
    yield `::error title=More failures::${failures - MAX_ANNOTATIONS} further failing tests are not annotated\n`;
}
