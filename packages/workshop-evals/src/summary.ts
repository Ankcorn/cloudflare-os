import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readEvalTaskMeta, type HarnessRun, type VitestJsonReport,
} from "@vitest-evals/core";
import { readVitestJsonReportFile } from "@vitest-evals/core/node";
import { z } from "zod";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(PACKAGE_DIR, ".wrangler", "evals");

const UsageSchema = z.object({
  complete: z.boolean(),
  successfulRequests: z.number().nonnegative(),
  failedRequests: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});

const RunOutputSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  expectation: z.enum(["required", "frontier"]),
  model: z.string(),
  trial: z.number().int().nonnegative(),
  runId: z.string(),
  functionalPassed: z.boolean(),
  agentErrors: z.array(z.string()),
  agentUsage: UsageSchema,
  wallDurationMs: z.number().nonnegative(),
});

const RunIdentitySchema = RunOutputSchema.pick({
  taskId: true,
  taskTitle: true,
  expectation: true,
  model: true,
  trial: true,
  runId: true,
});

const JudgeMetadataSchema = z.object({
  output: z.object({
    dimensions: z.array(z.object({ id: z.string(), score: z.number().min(1).max(5) })),
  }).optional(),
  judgeUsage: UsageSchema.optional(),
}).loose();

/** Closed numeric interval. */
export type ConfidenceInterval = {
  /** Lower 95% confidence bound. */
  low: number;
  /** Upper 95% confidence bound. */
  high: number;
};

/** Mean and selected quantiles for one efficiency metric. */
export type MetricDistribution = {
  /** Arithmetic mean. */
  mean: number;
  /** Median. */
  p50: number;
  /** 90th percentile. */
  p90: number;
};

/** Aggregated result for repeated runs of one task/model pair. */
export type WorkshopSummaryGroup = {
  /** Stable task identifier. */
  taskId: string;
  /** Human-readable task title. */
  taskTitle: string;
  /** Required or frontier result set. */
  expectation: "required" | "frontier";
  /** Agent model. */
  model: string;
  /** Trials with a valid harness output and outcome judgement. */
  validTrials: number;
  /** Trials missing valid output or judgement metadata. */
  invalidTrials: number;
  /** Valid trials whose deterministic checks all passed. */
  passCount: number;
  /** Functional pass rate among valid trials. */
  passRate: number | null;
  /** Wilson 95% interval for the functional pass rate. */
  passRateInterval: ConfidenceInterval | null;
  /** Mean normalized outcome score. */
  meanOutcomeScore: number | null;
  /** Sample standard deviation of outcome scores. */
  outcomeSampleSd: number | null;
  /** Student-t 95% interval for the mean outcome score. */
  outcomeMeanInterval: ConfidenceInterval | null;
  /** Mean 1-5 judge score keyed by rubric dimension ID. */
  rubricMeans: Record<string, number>;
  /** Combined agent and judge token distribution. */
  tokens: MetricDistribution | null;
  /** Agent-only token distribution. */
  agentTokens: MetricDistribution | null;
  /** Judge-only token distribution. */
  judgeTokens: MetricDistribution | null;
  /** Combined agent and judge model-duration distribution. */
  modelDurationMs: MetricDistribution | null;
  /** Agent-only model-duration distribution. */
  agentModelDurationMs: MetricDistribution | null;
  /** Judge-only model-duration distribution. */
  judgeModelDurationMs: MetricDistribution | null;
  /** Harness wall-duration distribution. */
  wallDurationMs: MetricDistribution | null;
  /** Combined agent and judge cost distribution. */
  costUsd: MetricDistribution | null;
  /** Agent-only cost distribution. */
  agentCostUsd: MetricDistribution | null;
  /** Judge-only cost distribution. */
  judgeCostUsd: MetricDistribution | null;
  /** Fraction of valid trials whose agent and judge Gateway metrics were complete. */
  telemetryCompleteRate: number | null;
  /** Fraction of valid trials containing a failed tool result. */
  toolFailureRate: number | null;
  /** Fraction of valid trials containing a failed agent or judge model request. */
  modelFailureRate: number | null;
  /** Fraction of valid trials containing a canonical agent error. */
  agentFailureRate: number | null;
};

/** Machine-readable aggregate over a canonical Vitest JSON report. */
export type WorkshopSummary = {
  /** Summary format version. */
  version: 1;
  /** Logical task/model groups, with required and frontier groups kept distinct. */
  groups: WorkshopSummaryGroup[];
};

type ValidTrial = {
  output: z.infer<typeof RunOutputSchema>;
  outcomeScore: number;
  rubricScores: { id: string; score: number }[];
  judgeUsage: z.infer<typeof UsageSchema> | undefined;
  toolFailed: boolean;
};

type GroupAccumulator = {
  taskId: string;
  taskTitle: string;
  expectation: "required" | "frontier";
  model: string;
  valid: ValidTrial[];
  invalid: number;
};

/** Wilson score interval for a binomial proportion at 95% confidence. */
export function wilsonInterval(successes: number, trials: number): ConfidenceInterval | null {
  if (trials === 0) return null;
  if (!Number.isInteger(successes) || !Number.isInteger(trials) ||
      successes < 0 || trials < 0 || successes > trials) {
    throw new Error("Wilson interval requires integer successes between zero and trials");
  }
  const z95 = 1.959963984540054;
  const proportion = successes / trials;
  const denominator = 1 + z95 ** 2 / trials;
  const center = (proportion + z95 ** 2 / (2 * trials)) / denominator;
  const margin = z95 * Math.sqrt(
      (proportion * (1 - proportion) + z95 ** 2 / (4 * trials)) / trials) / denominator;
  return { low: center - margin, high: center + margin };
}

/** Sample standard deviation, or null when fewer than two observations exist. */
export function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1));
}

const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function tCritical(degreesOfFreedom: number): number {
  if (degreesOfFreedom <= T_975.length) return T_975[degreesOfFreedom - 1] ?? 1.96;
  const z95 = 1.959963984540054;
  const inverseDf = 1 / degreesOfFreedom;
  return z95 + (z95 ** 3 + z95) * inverseDf / 4 +
    (5 * z95 ** 5 + 16 * z95 ** 3 + 3 * z95) * inverseDf ** 2 / 96 +
    (3 * z95 ** 7 + 19 * z95 ** 5 + 17 * z95 ** 3 - 15 * z95) * inverseDf ** 3 / 384;
}

/** Student-t 95% confidence interval for a sample mean. */
export function tMeanInterval(values: readonly number[]): ConfidenceInterval | null {
  const sd = sampleStandardDeviation(values);
  if (sd === null) return null;
  const average = mean(values);
  const margin = tCritical(values.length - 1) * sd / Math.sqrt(values.length);
  return { low: average - margin, high: average + margin };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values: readonly number[], probability: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted.at(lowerIndex);
  const upper = sorted.at(upperIndex);
  if (lower === undefined || upper === undefined) throw new Error("Cannot calculate an empty quantile");
  return lower + (upper - lower) * (index - lowerIndex);
}

/** Mean, p50, and p90 for a nonempty numeric sample. */
export function metricDistribution(values: readonly number[]): MetricDistribution | null {
  if (values.length === 0) return null;
  return { mean: mean(values), p50: quantile(values, 0.5), p90: quantile(values, 0.9) };
}

function toolFailed(run: HarnessRun): boolean {
  return run.session.events.some(event => event.type === "tool_result" && event.error !== undefined);
}

function readTrial(assertion: VitestJsonReport["testResults"][number]["assertionResults"][number]) {
  const metadata = readEvalTaskMeta(assertion.meta);
  if (metadata?.harness === undefined) {
    return { identity: undefined, output: undefined, valid: undefined };
  }
  const harnessRun = metadata.harness.run;
  if (harnessRun === undefined) throw new Error("Workshop eval result lacked a harness run");
  const output = RunOutputSchema.safeParse(harnessRun.output);
  const identity = RunIdentitySchema.safeParse(harnessRun.artifacts?.identity);
  const scores = metadata?.eval?.scores?.filter(score => score.name === "WorkshopOutcomeJudge") ?? [];
  const score = scores.at(0);
  const judgeMetadata = JudgeMetadataSchema.safeParse(score?.metadata);
  if (!output.success) {
    if (!identity.success) {
      throw new Error(`Workshop eval result lacked valid run identity: ${z.prettifyError(identity.error)}`);
    }
    return { identity: identity.data, output: undefined, valid: undefined };
  }
  if (scores.length !== 1 || typeof score?.score !== "number" ||
      !judgeMetadata.success) {
    return { identity: output.data, output: output.data, valid: undefined };
  }
  return {
    identity: output.data,
    output: output.data,
    valid: {
      output: output.data,
      outcomeScore: score.score,
      rubricScores: judgeMetadata.data.output?.dimensions ?? [],
      judgeUsage: judgeMetadata.data.judgeUsage,
      toolFailed: toolFailed(harnessRun),
    } satisfies ValidTrial,
  };
}

function groupKey(output: z.infer<typeof RunIdentitySchema>): string {
  return `${output.expectation}\u0000${output.taskId}\u0000${output.model}`;
}

function summarizeGroup(group: GroupAccumulator): WorkshopSummaryGroup {
  const passCount = group.valid.filter(trial => trial.output.functionalPassed).length;
  const outcomeScores = group.valid.map(trial => trial.outcomeScore);
  const rubric = new Map<string, number[]>();
  for (const trial of group.valid) {
    for (const dimension of trial.rubricScores) {
      const scores = rubric.get(dimension.id) ?? [];
      scores.push(dimension.score);
      rubric.set(dimension.id, scores);
    }
  }
  const combined = group.valid.map(trial => ({
    tokens: trial.output.agentUsage.totalTokens + (trial.judgeUsage?.totalTokens ?? 0),
    durationMs: trial.output.agentUsage.durationMs + (trial.judgeUsage?.durationMs ?? 0),
    costUsd: trial.output.agentUsage.costUsd + (trial.judgeUsage?.costUsd ?? 0),
    modelFailed: trial.output.agentUsage.failedRequests +
        (trial.judgeUsage?.failedRequests ?? 0) > 0,
  }));
  const validTrials = group.valid.length;
  const judgeTrials = group.valid.filter(trial => trial.judgeUsage !== undefined);
  return {
    taskId: group.taskId,
    taskTitle: group.taskTitle,
    expectation: group.expectation,
    model: group.model,
    validTrials,
    invalidTrials: group.invalid,
    passCount,
    passRate: validTrials === 0 ? null : passCount / validTrials,
    passRateInterval: wilsonInterval(passCount, validTrials),
    meanOutcomeScore: validTrials === 0 ? null : mean(outcomeScores),
    outcomeSampleSd: sampleStandardDeviation(outcomeScores),
    outcomeMeanInterval: tMeanInterval(outcomeScores),
    rubricMeans: Object.fromEntries([...rubric].map(([id, scores]) => [id, mean(scores)])),
    tokens: metricDistribution(combined.map(metric => metric.tokens)),
    agentTokens: metricDistribution(group.valid.map(trial => trial.output.agentUsage.totalTokens)),
    judgeTokens: metricDistribution(judgeTrials.map(trial => trial.judgeUsage?.totalTokens ?? 0)),
    modelDurationMs: metricDistribution(combined.map(metric => metric.durationMs)),
    agentModelDurationMs: metricDistribution(
        group.valid.map(trial => trial.output.agentUsage.durationMs)),
    judgeModelDurationMs: metricDistribution(
        judgeTrials.map(trial => trial.judgeUsage?.durationMs ?? 0)),
    wallDurationMs: metricDistribution(group.valid.map(trial => trial.output.wallDurationMs)),
    costUsd: metricDistribution(combined.map(metric => metric.costUsd)),
    agentCostUsd: metricDistribution(group.valid.map(trial => trial.output.agentUsage.costUsd)),
    judgeCostUsd: metricDistribution(judgeTrials.map(trial => trial.judgeUsage?.costUsd ?? 0)),
    telemetryCompleteRate: validTrials === 0 ? null : group.valid.filter(trial =>
      trial.output.agentUsage.complete &&
      (trial.judgeUsage === undefined || trial.judgeUsage.complete)).length / validTrials,
    toolFailureRate: validTrials === 0 ? null :
      group.valid.filter(trial => trial.toolFailed).length / validTrials,
    modelFailureRate: validTrials === 0 ? null :
      combined.filter(metric => metric.modelFailed).length / validTrials,
    agentFailureRate: validTrials === 0 ? null :
      group.valid.filter(trial => trial.output.agentErrors.length > 0).length / validTrials,
  };
}

/** Reduces canonical vitest-evals metadata into task/model reliability and efficiency groups. */
export function summarizeVitestReport(report: VitestJsonReport): WorkshopSummary {
  const groups = new Map<string, GroupAccumulator>();
  const seenTrials = new Set<string>();
  const seenRunIds = new Set<string>();
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      const trial = readTrial(assertion);
      if (trial.identity === undefined) continue;
      const key = groupKey(trial.identity);
      const trialKey = `${key}\u0000${trial.identity.trial}`;
      if (seenTrials.has(trialKey)) {
        throw new Error(
            `Duplicate Workshop eval trial ${trial.identity.taskId}/${trial.identity.model}/` +
            `${trial.identity.trial}`);
      }
      if (seenRunIds.has(trial.identity.runId)) {
        throw new Error(`Duplicate Workshop eval run ID ${trial.identity.runId}`);
      }
      seenTrials.add(trialKey);
      seenRunIds.add(trial.identity.runId);
      const group = groups.get(key) ?? {
        taskId: trial.identity.taskId,
        taskTitle: trial.identity.taskTitle,
        expectation: trial.identity.expectation,
        model: trial.identity.model,
        valid: [],
        invalid: 0,
      };
      if (trial.valid === undefined) group.invalid++;
      else group.valid.push(trial.valid);
      groups.set(key, group);
    }
  }
  return {
    version: 1,
    groups: [...groups.values()].map(summarizeGroup).toSorted((left, right) =>
      left.expectation.localeCompare(right.expectation) ||
      left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model)),
  };
}

/** Formats a concise Markdown view while preserving required/frontier labels. */
export function formatSummaryMarkdown(summary: WorkshopSummary): string {
  const rows = summary.groups.map(group => {
    const passRate = group.passRate === null ? "n/a" :
      `${(group.passRate * 100).toFixed(1)}% ` +
      `[${((group.passRateInterval?.low ?? 0) * 100).toFixed(1)}, ` +
      `${((group.passRateInterval?.high ?? 0) * 100).toFixed(1)}]`;
    const score = group.meanOutcomeScore === null ? "n/a" : group.meanOutcomeScore.toFixed(3);
    const tokens = group.tokens === null ? "n/a" : Math.round(group.tokens.mean).toLocaleString();
    const wall = group.wallDurationMs === null ? "n/a" : `${(group.wallDurationMs.p50 / 1_000).toFixed(1)}s`;
    const cost = group.costUsd === null ? "n/a" : group.costUsd.mean.toFixed(4);
    const toolFailures = group.toolFailureRate === null ? "n/a" :
      `${(group.toolFailureRate * 100).toFixed(1)}%`;
    return `| ${group.expectation} | ${group.taskTitle} | \`${group.model}\` | ` +
      `${group.validTrials} | ${group.invalidTrials} | ${passRate} | ${score} | ${tokens} | ` +
      `${wall} | ${cost} | ${toolFailures} |`;
  });
  return [
    "# Workshop Eval Summary",
    "",
    "Pass shows a Wilson 95% interval. Time is median end-to-end agent/harness wall time.",
    "",
    "| Set | Task | Model | Valid | Invalid | Functional pass | Outcome | Tokens mean | " +
      "Wall p50 | Cost mean | Tool-failure trials |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

/** Reads canonical Vitest JSON and writes `output/summary.json` plus `output/summary.md`. */
export async function writeWorkshopSummary(
    resultsPath = resolve(OUTPUT_DIR, "results.json"),
    outputName = "summary"): Promise<WorkshopSummary> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(outputName)) {
    throw new Error("Workshop summary output name must contain lowercase letters, numbers, or hyphens");
  }
  const summary = summarizeVitestReport(await readVitestJsonReportFile(resultsPath));
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(resolve(OUTPUT_DIR, `${outputName}.json`), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(resolve(OUTPUT_DIR, `${outputName}.md`), formatSummaryMarkdown(summary)),
  ]);
  return summary;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const args = process.argv.slice(2);
  if (args.at(0) === "--") args.shift();
  await writeWorkshopSummary(
      args[0] === undefined ? undefined : resolve(args[0]),
      args[1] ?? "summary");
}
