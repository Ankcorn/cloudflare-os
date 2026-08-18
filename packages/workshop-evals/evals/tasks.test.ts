import { describe, expect, it } from "vitest";
import { workshopEvalMatrix } from "./tasks.js";

describe("workshopEvalMatrix", () => {
  it("parses explicit models, trials, and run identity", () => {
    expect(workshopEvalMatrix({
      WORKSHOP_EVAL_MODELS: "model-a, model-b",
      WORKSHOP_EVAL_TRIALS: "3",
      WORKSHOP_EVAL_RUN_ID: "workflow-7",
    })).toEqual({ models: ["model-a", "model-b"], trials: 3, runId: "workflow-7" });
  });

  it("rejects empty, duplicate, or invalid matrix values", () => {
    expect(() => workshopEvalMatrix({ WORKSHOP_EVAL_MODELS: "" })).toThrow("non-empty");
    expect(() => workshopEvalMatrix({ WORKSHOP_EVAL_MODELS: "same,same" })).toThrow("duplicate");
    expect(() => workshopEvalMatrix({ WORKSHOP_EVAL_TRIALS: "0" })).toThrow("positive integer");
  });
});
