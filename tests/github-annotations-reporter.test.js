import assert from "node:assert/strict";
import test from "node:test";
import githubAnnotationsReporter from "../scripts/github-annotations-reporter.mjs";

async function collect(events) {
  async function* source() {
    for (const event of events) yield event;
  }
  const output = [];
  for await (const line of githubAnnotationsReporter(source())) output.push(line);
  return output;
}

test("failing tests become bounded GitHub error annotations", async () => {
  const lines = await collect([
    {
      type: "test:fail",
      data: {
        name: "deliberate failure",
        file: "C:\\repo\\tests\\example.test.js",
        line: 12,
        details: {
          error: Object.assign(new Error("Expected values to be strictly equal"), {
            code: "ERR_ASSERTION",
            expected: 2,
            actual: 1,
          }),
        },
      },
    },
    { type: "test:pass", data: { name: "fine" } },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error file=tests\/example\.test\.js,line=12,title=Test failed::deliberate failure/);
  assert.match(lines[0], /expected=2/);
  assert.match(lines[0], /actual=1/);
  assert.equal(lines[0].split("\n").length, 2);
  assert.ok(lines[0].length < 700);
});

test("annotation reporter bounds failures, escapes control characters, and refuses suite failures", async () => {
  const failures = Array.from({ length: 12 }, (_, i) => ({
    type: "test:fail",
    data: {
      name: i === 0 ? "danger%\r\n::warning::" : `failure-${i}`,
      details: { error: new Error("failure") },
    },
  }));
  const output = await collect([
    { type: "test:fail", data: { details: { type: "suite" } } },
    ...failures,
  ]);
  assert.equal(output.length, 11);
  assert.ok(output[0].includes("%25%0D%0A"));
  assert.ok(output[0].startsWith("::error "));
  assert.match(output[10], /2 further failing tests/);
});
