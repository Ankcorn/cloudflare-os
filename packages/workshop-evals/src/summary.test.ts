import type { HarnessRun, JsonValue, VitestJsonReport } from "@vitest-evals/core";
import { describe, expect, it } from "vitest";
import {
  formatSummaryMarkdown, metricDistribution, sampleStandardDeviation, summarizeVitestReport, tMeanInterval,
  wilsonInterval,
} from "./summary.js";

const runOutput = {
  taskId: "task",
  taskTitle: "Task",
  expectation: "required",
  model: "model",
  trial: 0,
  runId: "run-0",
  functionalPassed: true,
  agentErrors: [],
  agentUsage: {
    complete: true,
    successfulRequests: 2,
    failedRequests: 0,
    inputTokens: 6,
    outputTokens: 4,
    totalTokens: 10,
    durationMs: 100,
    costUsd: 0.1,
  },
  wallDurationMs: 1_000,
};

function harnessRun(output: JsonValue, toolFailed = false): HarnessRun {
  return {
    output,
    session: {
      events: toolFailed ? [{
        type: "tool_result",
        toolCallId: "call",
        error: { name: "Error", message: "failed" },
      }] : [],
    },
    usage: {},
    errors: [],
  };
}

function report(): VitestJsonReport {
  return {
    numFailedTests: 1,
    numPassedTests: 2,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTests: 3,
    startTime: 0,
    success: false,
    testResults: [{
      message: "",
      name: "eval",
      status: "failed",
      assertionResults: [
        {
          ancestorTitles: [], fullName: "one", title: "one", status: "failed",
          meta: {
            harness: { name: "workshop", run: harnessRun(runOutput) },
            eval: {
              avgScore: 0.75,
              scores: [{
                name: "WorkshopOutcomeJudge",
                score: 0.75,
                metadata: {
                  output: { dimensions: [{ id: "visual", score: 4 }] },
                  judgeUsage: {
                    complete: true,
                    successfulRequests: 1, failedRequests: 0,
                    inputTokens: 2, outputTokens: 1, totalTokens: 3,
                    durationMs: 20, costUsd: 0.02,
                  },
                },
              }],
            },
          },
        },
        {
          ancestorTitles: [], fullName: "two", title: "two", status: "passed",
          meta: {
            harness: { name: "workshop", run: harnessRun({
              ...runOutput,
              trial: 1,
              runId: "run-1",
              functionalPassed: false,
              agentErrors: ["agent failed"],
              agentUsage: { ...runOutput.agentUsage, failedRequests: 1 },
              wallDurationMs: 2_000,
            }, true) },
            eval: {
              avgScore: 0,
              scores: [{
                name: "WorkshopOutcomeJudge",
                score: 0,
                metadata: { output: { dimensions: [{ id: "visual", score: 2 }] } },
              }],
            },
          },
        },
        {
          ancestorTitles: [], fullName: "invalid", title: "invalid", status: "failed",
          meta: { harness: { name: "workshop", run: harnessRun({
            ...runOutput,
            trial: 2,
            runId: "run-2",
          }) } },
        },
      ],
    }],
  };
}

describe("statistics", () => {
  it("calculates Wilson bounds and sample uncertainty", () => {
    expect(wilsonInterval(5, 10)).toEqual({
      low: expect.closeTo(0.2366, 3),
      high: expect.closeTo(0.7634, 3),
    });
    expect(sampleStandardDeviation([1, 2, 3])).toBe(1);
    expect(tMeanInterval([1, 2, 3])).toEqual({
      low: expect.closeTo(-0.484, 2),
      high: expect.closeTo(4.484, 2),
    });
  });

  it("calculates means and interpolated percentiles", () => {
    expect(metricDistribution([1, 2, 3, 4])).toEqual({ mean: 2.5, p50: 2.5, p90: 3.7 });
  });
});

describe("summarizeVitestReport", () => {
  it("groups valid and invalid repeats with outcome, efficiency, and diagnostic metrics", () => {
    const group = summarizeVitestReport(report()).groups.at(0);
    expect(group).toMatchObject({
      expectation: "required",
      validTrials: 2,
      invalidTrials: 1,
      passCount: 1,
      passRate: 0.5,
      meanOutcomeScore: 0.375,
      rubricMeans: { visual: 3 },
      toolFailureRate: 0.5,
      modelFailureRate: 0.5,
      agentFailureRate: 0.5,
      tokens: { mean: 11.5 },
      agentTokens: { mean: 10 },
      judgeTokens: { mean: 3 },
      modelDurationMs: { mean: 110 },
      agentModelDurationMs: { mean: 100 },
      judgeModelDurationMs: { mean: 20 },
      wallDurationMs: { mean: 1_500 },
      costUsd: { mean: expect.closeTo(0.11, 10) },
      agentCostUsd: { mean: 0.1 },
      judgeCostUsd: { mean: 0.02 },
      telemetryCompleteRate: 1,
    });
  });

  it("rejects duplicate logical trials instead of inflating the sample", () => {
    const duplicate = report();
    const assertions = duplicate.testResults.at(0)?.assertionResults;
    const first = assertions?.at(0);
    if (assertions === undefined || first === undefined) throw new Error("test report fixture is empty");
    assertions.push(first);
    expect(() => summarizeVitestReport(duplicate)).toThrow("Duplicate Workshop eval trial");
  });

  it("rejects malformed harness runs instead of omitting invalid trials", () => {
    const malformed = report();
    const assertion = malformed.testResults.at(0)?.assertionResults.at(0);
    if (assertion === undefined) throw new Error("test report fixture is empty");
    assertion.meta = { harness: { name: "workshop", run: harnessRun({ broken: true }) } };
    expect(() => summarizeVitestReport(malformed)).toThrow("lacked valid run identity");
  });

  it("formats reliability and efficiency metrics for human review", () => {
    const markdown = formatSummaryMarkdown(summarizeVitestReport(report()));
    expect(markdown).toContain("Wilson 95% interval");
    expect(markdown).toContain("Tool-failure trials");
    expect(markdown).toContain("| 12 |");
  });
});
