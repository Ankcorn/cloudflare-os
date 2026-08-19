import { createJudge } from "vitest-evals";
import type { EvalRunInput, EvalRunOutput } from "./task.js";

/**
 * Scores a run on the fraction of its deterministic checks that passed.
 *
 * The score is reproducible: it depends only on what the agent built and what the task asserted,
 * so a change in the number tracks a change in the agent rather than in a grader. Partial credit is
 * reported because a frontier task that satisfies most of a contract is meaningfully closer than
 * one that satisfies none, while `EvalRunOutput.passed` remains the all-or-nothing verdict.
 */
export const ChecksScorer = createJudge<EvalRunInput, EvalRunOutput>("checks", ({ output }) => {
  const checks = output.turns.flatMap(turn => turn.checks);
  if (checks.length === 0) {
    return { score: null, metadata: { rationale: `task ${output.taskId} recorded no checks` } };
  }
  // An agent that errored without ever calling a tool never got going -- an expired token, a
  // provider outage. Scoring that as zero would blame the agent for infrastructure and quietly
  // drag down the pass rate; an unscored trial is counted as invalid instead.
  if (output.diagnostics.toolCalls === 0 && output.diagnostics.agentErrors.length > 0) {
    return {
      score: null,
      metadata: {
        rationale: "the agent made no tool calls and reported an error, so it never ran",
        agentErrors: output.diagnostics.agentErrors,
      },
    };
  }
  const failed = checks.filter(check => !check.pass);
  return {
    score: (checks.length - failed.length) / checks.length,
    metadata: {
      rationale: failed.length === 0
        ? `all ${checks.length} checks passed`
        : `${failed.length} of ${checks.length} checks failed: ` +
          failed.map(check => check.id).join(", "),
      failed: failed.map(check => ({ id: check.id, evidence: check.evidence ?? null })),
    },
  };
});
