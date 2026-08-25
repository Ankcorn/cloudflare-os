import { execFileSync } from "node:child_process";

const DEFAULT_MODELS = ["@cf/zai-org/glm-5.2", "@cf/moonshotai/kimi-k2.7-code"];
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

/** Time reserved for cleanup after agent work. */
export const EVAL_OVERHEAD_BUDGET_MS = 2 * 60_000;
/** Total agent and verifier budget for one trial. */
export const EVAL_RUN_BUDGET_MS = 30 * 60_000;
/** Outer Vitest deadline includes the cleanup reserve. */
export const EVAL_TEST_TIMEOUT_MS = EVAL_RUN_BUDGET_MS + EVAL_OVERHEAD_BUDGET_MS;

function commaList(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function localGitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Identify the checkout that supplied both the local Workshop and its eval code. */
export function resolveEvalCommit(
    environment: NodeJS.ProcessEnv = process.env,
    readLocalCommit: () => string = localGitCommit): string {
  const commit = environment.WORKSHOP_EVAL_COMMIT?.trim() ||
    environment.GITHUB_SHA?.trim() || readLocalCommit();
  if (!GIT_SHA_PATTERN.test(commit)) {
    throw new Error("WORKSHOP_EVAL_COMMIT must be a full 40-character Git SHA");
  }
  return commit;
}

export type EvalIdentity = { gitCommit: string; taskVersion: string };

/** Whether failures in this task should fail the run. */
export function evalGatesTask(
    taskId: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.WORKSHOP_EVAL_GATING_TASKS;
  if (configured === undefined || configured.trim() === "all") return true;
  return commaList(configured).includes(taskId);
}

/** Parse model and trial controls. */
export function evalMatrix(environment: NodeJS.ProcessEnv = process.env) {
  const models = commaList(environment.WORKSHOP_EVAL_MODELS ?? "");
  const rawTrials = environment.WORKSHOP_EVAL_TRIALS?.trim();
  const trials = rawTrials === undefined || rawTrials === "" ? 1 : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error("WORKSHOP_EVAL_TRIALS must be a positive integer");
  }
  return { models: models.length > 0 ? models : [...DEFAULT_MODELS], trials };
}
