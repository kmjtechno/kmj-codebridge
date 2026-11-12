import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOffsitePrefixJournal,
  fixedOffsitePrefixLineStatus,
} from "../src/offsite-prefix-line-status.js";

const INV = "d".repeat(32);
const unit = { installed: true, result: "exit-code", execMainStatus: "3" };
const observed = (line) => "HOSTKEY_PIN=PASS\nLOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=" + line + "\nPRECHECK_BLOCKER=LOCAL_BACKUP_PREFIX_FAILED\n";

test("exact scoped numeric marker is accepted without any other log lines disclosed", () => {
  for (const line of ["LINE_01", "LINE_09", "LINE_28"]) {
    const calls = [];
    const result = fixedOffsitePrefixLineStatus({
      unit, invocationID: INV,
      run(exe, args, opts) {
        calls.push({ exe, args, opts });
        return observed(line);
      },
    });
    assert.deepEqual(result, {
      line, journalScope: "EXACT_INVOCATION", rawJournalExposed: false,
      backupVerified: false, restoreVerified: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, "/usr/bin/journalctl");
    assert.equal(calls[0].args.at(-1), "_SYSTEMD_INVOCATION_ID=" + INV);
    assert.equal(calls[0].args[2], "--lines=200");
  }
});

test("malformed, duplicate, unbounded or spoofed markers never become line evidence", () => {
  const bad = [
    "", observed("LINE_00"), observed("LINE_29"), observed("LINE_1"),
    observed("LINE_08 EXTRA"), observed("UNKNOWN"),
    observed("LINE_08") + observed("LINE_09"),
    "noise\n" + observed("LINE_08").replace(
      "LOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=", "LOCAL_PREFIX_ERR_TRAP_LINE_CANDIDATE=LINE_08=BAD_"
    ),
    observed("LINE_08") + "x".repeat(9000),
  ];
  for (const input of bad) {
    assert.equal(parseOffsitePrefixJournal(input), "UNKNOWN", input.slice(0, 120));
  }
});

test("ineligible status or invalid invocation refuses journal I/O", () => {
  let calls = 0;
  const run = () => { calls++; return observed("LINE_12"); };
  const trials = [
    { unit: { ...unit, installed: false }, invocationID: INV },
    { unit: { ...unit, result: "success" }, invocationID: INV },
    { unit: { ...unit, execMainStatus: "255" }, invocationID: INV },
    { unit, invocationID: "nothex" },
    { unit, invocationID: INV + "FF" },
    { unit, invocationID: "../../etc" },
  ];
  for (const trial of trials) {
    assert.equal(fixedOffsitePrefixLineStatus({ ...trial, run }).line, "UNKNOWN");
  }
  assert.equal(calls, 0);
});

test("journal errors and raw content are always suppressed", () => {
  const denied = fixedOffsitePrefixLineStatus({
    unit, invocationID: INV, run() {
      throw Error("PRIVATE_JOURNAL_SHOULD_NOT_LEAK");
    },
  });
  assert.equal(denied.line, "UNKNOWN");
  assert.equal(denied.rawJournalExposed, false);
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_JOURNAL|password|root/);
  assert.equal(fixedOffsitePrefixLineStatus({
    unit, invocationID: INV,
    run: () => ({ output: observed("LINE_07") }),
  }).line, "UNKNOWN");
});

test("nonfailing invocations never return success or backup approval", () => {
  const output = fixedOffsitePrefixLineStatus({
    unit: { ...unit, result: "success", execMainStatus: "0" },
    invocationID: INV, run: () => assert.fail("must not query journal"),
  });
  assert.deepEqual(output, {
    line: "UNKNOWN", journalScope: "UNAVAILABLE", rawJournalExposed: false,
    backupVerified: false, restoreVerified: false,
  });
});
