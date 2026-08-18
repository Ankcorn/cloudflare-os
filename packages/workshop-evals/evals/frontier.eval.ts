import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createWorkshopHarness } from "../src/workshop-harness.js";
import { createWorkshopOutcomeJudge } from "../src/outcome-judge.js";
import { frontierTasks, workshopEvalMatrix } from "./tasks.js";

const { models, trials, runId } = workshopEvalMatrix();

for (const task of frontierTasks) {
  for (const model of models) {
    for (let trial = 1; trial <= trials; trial++) {
      const name = `${task.id} | ${model} | trial ${trial}`;
      const input = {
        model,
        trial: trial - 1,
        runId: `${runId}:${task.id}:${model}:trial-${trial}`,
      };
      describeEval(name, { harness: createWorkshopHarness(task) }, it => {
        it(name, async ({ run }) => {
          const result = await run(input);
          await expect(result).toSatisfyJudge(createWorkshopOutcomeJudge(task), { threshold: null });
        });
      });
    }
  }
}
