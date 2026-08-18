import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUDGE_MODEL, judgePromptSchemaHash, normalizedQualityScore, requestOutcomeJudgement,
  type OutcomeJudgeRunEvidence, type OutcomeJudgeTaskEvidence,
} from "../src/outcome-judge.js";
import { parseGatewayEnvironment } from "../src/gateway-logs.js";
import { JUDGE_CANARY_FIXTURES, type JudgeCanaryFixture } from "../fixtures/judge-canary/cases.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_SCHEMA_HASH = judgePromptSchemaHash();
const SEED = 42;

function taskFor(fixture: JudgeCanaryFixture): OutcomeJudgeTaskEvidence {
  return {
    title: fixture.title,
    turns: [{ prompt: fixture.prompt }],
    rubric: fixture.rubric,
  };
}

function outputFor(fixture: JudgeCanaryFixture): OutcomeJudgeRunEvidence {
  return {
    runId: `judge-canary-${fixture.id}`,
    turns: [{ checks: fixture.checks }],
    gadgets: [{ title: fixture.title }],
  };
}

describe(`judge drift canary model=${DEFAULT_JUDGE_MODEL} promptSchemaSha256=${PROMPT_SCHEMA_HASH}`, () => {
  for (const fixture of JUDGE_CANARY_FIXTURES) {
    it(`${fixture.id} model=${DEFAULT_JUDGE_MODEL} promptSchemaSha256=${PROMPT_SCHEMA_HASH}`, async () => {
      const task = taskFor(fixture);
      const output = outputFor(fixture);
      const bytes = await readFile(resolve(PACKAGE_DIR, "fixtures/judge-canary", fixture.image));
      const judgement = await requestOutcomeJudgement(
          task,
          output,
          [{
            title: fixture.title,
            viewport: "desktop",
            dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          }],
          parseGatewayEnvironment(),
          DEFAULT_JUDGE_MODEL,
          SEED,
          fetch,
      );

      const score = normalizedQualityScore(fixture.rubric, judgement);
      expect(score).toBeGreaterThanOrEqual(fixture.expectedScore[0]);
      expect(score).toBeLessThanOrEqual(fixture.expectedScore[1]);
      for (const dimension of judgement.dimensions) {
        const expected = fixture.expectedDimensions[dimension.id];
        expect(expected, `missing expected band for ${dimension.id}`).toBeDefined();
        if (expected !== undefined) {
          expect(dimension.score, dimension.id).toBeGreaterThanOrEqual(expected[0]);
          expect(dimension.score, dimension.id).toBeLessThanOrEqual(expected[1]);
        }
      }
    });
  }
});
