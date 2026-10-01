import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "plugin/plugin.json"), "utf8"),
);
const openai = manifest.extensions?.["com.openai"];
const ui = openai?.interface;

test("OpenAI directory listing metadata satisfies submission-shape requirements", () => {
  assert.equal(manifest.name, "kmj-codebridge");
  assert.ok(manifest.author?.url?.startsWith("https://"));
  assert.ok(ui.displayName.length <= 30);
  assert.ok(ui.shortDescription.length <= 30);
  assert.ok(ui.longDescription.length <= 4000);
  assert.equal(ui.developerName, "KMJ TECHNO");
  assert.equal(ui.category, "Developer Tools");
  for (const field of [
    "websiteURL",
    "supportURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
  ]) {
    const url = new URL(ui[field]);
    assert.equal(url.protocol, "https:", field);
    assert.equal(url.username, "", field);
    assert.equal(url.password, "", field);
  }
  for (const field of ["logo", "composerIcon"]) {
    assert.ok(ui[field].startsWith("./assets/"));
    assert.ok(fs.existsSync(path.join(root, "plugin", ui[field])));
  }
  assert.ok(Array.isArray(ui.defaultPrompt));
  assert.ok(ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) assert.ok(prompt.length <= 128);
});

test("OpenAI initial MCP review metadata contains exactly five positive and three negative cases", () => {
  const cases = openai.review?.test_cases;
  assert.equal(cases?.positive?.length, 5);
  assert.equal(cases?.negative?.length, 3);
  for (const item of cases.positive) {
    assert.ok(item.description);
    assert.ok(item.prompt);
    assert.ok(item.tools_triggered);
    assert.ok(item.expected_behavior);
  }
  for (const item of cases.negative) {
    assert.ok(item.description);
    assert.ok(item.prompt);
  }
  assert.equal(openai.review.commerce, false);
  assert.ok(openai.publication?.release_notes);
});

test("OpenAI onboarding points to the packaged canonical skill", () => {
  assert.equal(openai.onboardingSkill, "./skills/codebridge/SKILL.md");
  assert.ok(
    fs.existsSync(
      path.join(root, "plugin", openai.onboardingSkill.replace(/^\.\//, "")),
    ),
  );
});
