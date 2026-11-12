import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { definitions } from "../src/tools.js";
import {
  buildMission,
  parseRoadmapPhases,
} from "../scripts/roadmap-mission.mjs";

const roadmap = readFileSync(
  new URL("../docs/specs/KMJ-CodeBridge-Roadmap.yaml", import.meta.url),
  "utf8",
);
const scope = { project: "kmj-codebridge", device: "p520" };

test("roadmap mission is a valid mission_compile payload", () => {
  const mission = buildMission(roadmap, scope);
  const parsed = z
    .object(definitions.mission_compile.input)
    .strict()
    .parse(mission);
  assert.equal(parsed.key.startsWith("roadmap-v"), true);
  assert.ok(parsed.tasks.length >= 1 && parsed.tasks.length <= 50);
});

test("task DAG references only known tasks and is acyclic", () => {
  const { tasks } = buildMission(roadmap, scope);
  const keys = new Set(tasks.map((task) => task.key));
  assert.equal(keys.size, tasks.length);
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const task of tasks) {
      if (done.has(task.key)) continue;
      for (const dep of task.dependsOn) assert.ok(keys.has(dep), dep);
      if (task.dependsOn.every((dep) => done.has(dep))) {
        done.add(task.key);
        progress = true;
      }
    }
  }
  assert.equal(done.size, tasks.length, "dependency cycle");
});

test("completed phases are skipped and every open deliverable becomes a task", () => {
  const phases = parseRoadmapPhases(roadmap);
  const { tasks } = buildMission(roadmap, scope);
  for (const phase of phases) {
    const own = tasks.filter((task) => task.key.startsWith(phase.id + "."));
    if (phase.status === "completed") assert.equal(own.length, 0, phase.id);
    else assert.equal(own.length, phase.deliverables.length + 1, phase.id);
  }
});

test("parser fails closed on unrecognised roadmap lines", () => {
  const broken = roadmap.replace(
    "roadmap_phases:\n",
    "roadmap_phases:\n  surprise: true\n",
  );
  assert.throws(() => parseRoadmapPhases(broken), /ROADMAP_LINE_UNRECOGNISED/);
});

test("converter is read-only (no process, network or file writes)", () => {
  const source = readFileSync(
    new URL("../scripts/roadmap-mission.mjs", import.meta.url),
    "utf8",
  );
  for (const banned of [
    "child_process",
    "writeFile",
    "fetch(",
    "node:http",
    "node:net",
  ])
    assert.equal(source.includes(banned), false, banned);
});
