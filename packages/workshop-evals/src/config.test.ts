import { expect, it } from "vitest";
import {
  EVAL_RUN_BUDGET_MS, EVAL_TEST_TIMEOUT_MS, evalGatesTask, evalMatrix, resolveEvalCommit,
} from "./config.js";
import { taskVersion, type EvalTask } from "./task.js";

it("reserves cleanup time outside the run budget", () => {
  expect(EVAL_TEST_TIMEOUT_MS).toBeGreaterThan(EVAL_RUN_BUDGET_MS);
});

it("uses both Workers AI models and one trial by default", () => {
  expect(evalMatrix({})).toEqual({
    models: ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"],
    trials: 1,
  });
});

it("accepts model and trial overrides", () => {
  expect(evalMatrix({
    WORKSHOP_EVAL_MODELS: " model-a, model-b ",
    WORKSHOP_EVAL_TRIALS: "3",
  })).toEqual({ models: ["model-a", "model-b"], trials: 3 });
});

it("gates every task by default and allows reporting-only runs", () => {
  expect(evalGatesTask("project-doc", {})).toBe(true);
  expect(evalGatesTask("project-doc", { WORKSHOP_EVAL_GATING_TASKS: "all" })).toBe(true);
  expect(evalGatesTask("project-doc", {
    WORKSHOP_EVAL_GATING_TASKS: "project-doc, appointment-desk",
  })).toBe(true);
  expect(evalGatesTask("expense-ledger", {
    WORKSHOP_EVAL_GATING_TASKS: "project-doc, appointment-desk",
  })).toBe(false);
  expect(evalGatesTask("project-doc", { WORKSHOP_EVAL_GATING_TASKS: "" })).toBe(false);
});

it("rejects an invalid trial count", () => {
  expect(() => evalMatrix({ WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
});

const COMMIT = "a".repeat(40);

it("records the checkout commit", () => {
  expect(resolveEvalCommit({ GITHUB_SHA: COMMIT }, () => "unused")).toBe(COMMIT);
  expect(resolveEvalCommit({}, () => COMMIT)).toBe(COMMIT);
  expect(() => resolveEvalCommit({ WORKSHOP_EVAL_COMMIT: "main" }, () => COMMIT))
    .toThrow("40-character Git SHA");
});

it("versions only the task prompts", () => {
  const task: EvalTask = {
    id: "one",
    turns: [{ prompt: "Build it", verify: () => Promise.resolve() }],
  };
  const version = taskVersion(task);
  expect(version).toMatch(/^[a-f0-9]{64}$/);
  expect(taskVersion({
    ...task,
    turns: [{ prompt: "Build it", verify: async () => { await Promise.resolve(); } }],
  })).toBe(version);
  expect(taskVersion({ ...task, turns: [{ ...task.turns[0], prompt: "Build it better" }] }))
    .not.toBe(version);
});
