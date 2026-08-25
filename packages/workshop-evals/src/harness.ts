import type { AgentTurnResult } from "@gadgets/integration-tests/agent-session";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { createHarness, type JsonValue } from "vitest-evals";
import { EVAL_OVERHEAD_BUDGET_MS, EVAL_RUN_BUDGET_MS, type EvalIdentity } from "./config.js";
import type { EvalRunInput, EvalRunOutput, EvalTask, EvalTurnResult } from "./task.js";
import { measureHistory, toTranscriptEvents } from "./transcript.js";
import { openWorkshopTarget, type LocalModelAccess } from "./target.js";
import { EvalVerifier } from "./verifier.js";

/** Run one real Workshop task through vitest-evals. */
export function createWorkshopHarness(
    task: EvalTask, access: LocalModelAccess, identity: EvalIdentity, gatesRun: boolean) {
  return createHarness<EvalRunInput, EvalRunOutput>({
    name: "workshop-agent",
    run: async ({ input, signal }) => {
      const startedAt = Date.now();
      const turnTimeoutMs = Math.floor(
          (EVAL_RUN_BUDGET_MS - EVAL_OVERHEAD_BUDGET_MS) / task.turns.length);
      await using opened = await openWorkshopTarget(access, input.model, turnTimeoutMs);
      const turns: EvalTurnResult[] = [];
      let history: AiChatMessage[] = [];
      let usage: AgentTurnResult["usage"] = {};

      for (const turn of task.turns) {
        const agentStartedAt = Date.now();
        const result = await opened.session.run(turn.prompt, signal);
        const agentDurationMs = Date.now() - agentStartedAt;
        ({ history } = result);
        usage = result.usage;

        const verificationStartedAt = Date.now();
        const verifier = new EvalVerifier(opened.session, result.workpieces);
        turns.push({
          checks: await verifier.collect(turn.verify),
          agentDurationMs,
          verificationDurationMs: Date.now() - verificationStartedAt,
        });
      }

      const { toolCalls, ...metrics } = measureHistory(history);
      const usageMetadata: Record<string, JsonValue> = {};
      if (usage.lastStepTokens !== undefined) usageMetadata.lastStepTokens = usage.lastStepTokens;
      if (usage.agentChatCostUsd !== undefined) {
        usageMetadata.agentChatCostUsd = usage.agentChatCostUsd;
      }
      return {
        output: { turns, metrics },
        events: toTranscriptEvents(history),
        usage: {
          provider: "cloudflare",
          model: input.model,
          toolCalls,
          metadata: usageMetadata,
        },
        timings: { totalMs: Date.now() - startedAt },
        errors: history.flatMap(message =>
          message.type === "error" ? [{ name: "AgentError", message: message.message }] : []),
        metadata: {
          taskId: task.id,
          gatesRun,
          target: "local",
          ...identity,
        },
      };
    },
  });
}
